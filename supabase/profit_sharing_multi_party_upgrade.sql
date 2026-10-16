-- NewShop：多人分潤；先執行 profit_sharing_upgrade.sql。
-- 僅新增 v2 結算函式，不更動既有已分潤紀錄或發貨資料。
begin;
create or replace function public.admin_complete_profit_share_v2(p_item_ids uuid[], p_settings jsonb)
returns public.profit_share_settlements
language plpgsql security definer set search_path = ''
as $$
declare
  item record;
  expense jsonb;
  expected jsonb;
  parties jsonb := p_settings->'parties';
  collector integer := (p_settings->>'collector')::integer;
  payer integer;
  received numeric := round((p_settings->>'received')::numeric, 2);
  revenue numeric := 0;
  item_cost numeric := 0;
  extra_cost numeric := 0;
  cost numeric;
  party_count integer;
  ratio numeric;
  ratio_sum numeric := 0;
  allocated numeric := 0;
  advances numeric[];
  shares numeric[];
  profit numeric;
  items jsonb := '[]'::jsonb;
  expenses jsonb := '[]'::jsonb;
  result_parties jsonb := '[]'::jsonb;
  result public.profit_share_settlements;
  i integer;
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if coalesce(cardinality(p_item_ids), 0) = 0 or exists (select 1 from unnest(p_item_ids) id where id is null)
    or cardinality(p_item_ids) <> (select count(distinct id) from unnest(p_item_ids) id) then raise exception 'NO_ITEMS_SELECTED'; end if;
  if jsonb_typeof(parties) is distinct from 'array' then raise exception 'INVALID_PROFIT_SETTINGS'; end if;
  party_count := jsonb_array_length(parties);
  if party_count < 1 then raise exception 'INVALID_PROFIT_SETTINGS'; end if;
  for i in 0..party_count - 1 loop
    ratio := (parties->i->>'ratio')::numeric;
    if ratio is null or ratio::text in ('NaN', 'Infinity', '-Infinity') or ratio < 0 or ratio > 100 or ratio <> trunc(ratio)
      or nullif(trim(parties->i->>'name'), '') is null then raise exception 'INVALID_PROFIT_SETTINGS'; end if;
    ratio_sum := ratio_sum + ratio;
  end loop;
  if ratio_sum <> 100 or (select count(distinct trim(value->>'name')) from jsonb_array_elements(parties)) <> party_count
    or collector is null or collector < 0 or collector >= party_count or received is null or received < 0 or received::text in ('NaN', 'Infinity', '-Infinity')
    or (p_settings->>'receivedConfirmed') is distinct from 'true'
    or jsonb_typeof(p_settings->'expenses') is distinct from 'array' then raise exception 'INVALID_PROFIT_SETTINGS'; end if;
  advances := array_fill(0::numeric, array[party_count]);
  -- 分潤與還原均鎖住同一品項，避免同時操作造成重複分潤或狀態誤判。
  perform id from public.order_items where id = any(p_item_ids) order by id for update;
  perform order_item_id from public.order_item_fulfillments where order_item_id = any(p_item_ids) order by order_item_id for update;
  if exists (select 1 from public.profit_share_items where order_item_id = any(p_item_ids)) then raise exception 'PROFIT_ITEM_ALREADY_SETTLED'; end if;
  if exists (
    select 1 from unnest(p_item_ids) requested(id)
    left join public.order_items oi on oi.id = requested.id
    left join public.orders o on o.id = oi.order_id
    left join public.order_item_fulfillments f on f.order_item_id = oi.id
    where oi.id is null or o.status = 'cancelled' or f.shipped_at is null or f.completed_at is null
  ) then raise exception 'PROFIT_ITEM_STATE_CHANGED'; end if;
  for item in
    select oi.*, o.order_number, o.recipient_name,
      coalesce(oi.unit_cost, pc.cost, 0) as effective_cost
    from public.order_items oi join public.orders o on o.id = oi.order_id
    left join public.product_costs pc on pc.product_id = oi.product_id
    where oi.id = any(p_item_ids) order by o.created_at, oi.id
  loop
    select value into expected from jsonb_array_elements(p_settings->'expected_items') where value->>'id' = item.id::text;
    if expected is null or (expected->>'quantity')::numeric is distinct from item.quantity
      or (expected->>'unit_price')::numeric is distinct from item.unit_price
      or (expected->>'unit_cost')::numeric is distinct from item.effective_cost then raise exception 'PROFIT_ITEM_AMOUNT_CHANGED'; end if;
    payer := (p_settings->'payers'->>item.id::text)::integer;
    if payer is null or payer < 0 or payer >= party_count then raise exception 'INVALID_PROFIT_SETTINGS'; end if;
    cost := round(item.effective_cost * item.quantity, 2);
    advances[payer + 1] := advances[payer + 1] + cost;
    item_cost := item_cost + cost; revenue := revenue + round(item.unit_price * item.quantity, 2);
    items := items || jsonb_build_array(jsonb_build_object('id', item.id, 'order_id', item.order_id, 'order_number', item.order_number,
      'recipient', item.recipient_name, 'product_id', item.product_id, 'name', item.product_name, 'quantity', item.quantity,
      'unit_price', item.unit_price, 'unit_cost', item.effective_cost, 'payer', payer));
  end loop;
  for expense in select value from jsonb_array_elements(p_settings->'expenses') loop
    payer := (expense->>'payer')::integer; cost := round((expense->>'amount')::numeric, 2);
    if payer is null or payer < 0 or payer >= party_count or cost is null or cost < 0 or cost::text in ('NaN', 'Infinity', '-Infinity')
      or nullif(trim(expense->>'description'), '') is null then raise exception 'INVALID_PROFIT_SETTINGS'; end if;
    advances[payer + 1] := advances[payer + 1] + cost; extra_cost := extra_cost + cost;
    expenses := expenses || jsonb_build_array(jsonb_build_object('description', trim(expense->>'description'), 'amount', cost, 'payer', payer));
  end loop;
  profit := received - item_cost - extra_cost;
  -- 依比例分至分，以小數餘數分配尾差；餘數相同時第一位優先。
  shares := array_fill(0::numeric, array[party_count]);
  for i in 0..party_count - 1 loop
    shares[i + 1] := floor(abs(profit) * (parties->i->>'ratio')::numeric) / 100;
    allocated := allocated + shares[i + 1];
  end loop;
  for i in
    select (ordinality - 1)::integer from jsonb_array_elements(parties) with ordinality
    order by abs(profit) * (value->>'ratio')::numeric - floor(abs(profit) * (value->>'ratio')::numeric) desc, ordinality
    limit (round((abs(profit) - allocated) * 100)::integer)
  loop
    shares[i + 1] := shares[i + 1] + 0.01;
  end loop;
  if profit < 0 then
    for i in 1..party_count loop shares[i] := -shares[i]; end loop;
  end if;
  for i in 0..party_count - 1 loop
    result_parties := result_parties || jsonb_build_array(jsonb_build_object('name', trim(parties->i->>'name'), 'ratio', (parties->i->>'ratio')::numeric,
      'advance', advances[i + 1], 'share', shares[i + 1],
      'balance', advances[i + 1] + shares[i + 1] - case when i = collector then received else 0 end));
  end loop;
  insert into public.profit_share_settlements(created_by, snapshot)
  values (auth.uid(), jsonb_build_object('title', trim(coalesce(p_settings->>'title', '')), 'revenue', revenue, 'received', received,
    'item_cost', item_cost, 'extra_cost', extra_cost, 'profit', profit, 'collector', collector, 'parties', result_parties, 'expenses', expenses, 'items', items))
  returning * into result;
  insert into public.profit_share_items(order_item_id, settlement_id) select id, result.id from unnest(p_item_ids) id;
  return result;
end;
$$;
revoke all on function public.admin_complete_profit_share_v2(uuid[], jsonb) from public;
grant execute on function public.admin_complete_profit_share_v2(uuid[], jsonb) to authenticated;
commit;
