-- NewShop：分潤清單。先執行 fulfillment_upgrade.sql、shipment_completion_upgrade.sql。
-- 在 Supabase SQL Editor 執行；不搬移或刪除既有發貨資料。
begin;
create table if not exists public.profit_share_settlements (
  id uuid primary key default gen_random_uuid(),
  completed_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  snapshot jsonb not null
);
-- 保留品項 ID，即使原訂單日後刪除，分潤歷史仍存在。
create table if not exists public.profit_share_items (
  order_item_id uuid primary key,
  settlement_id uuid not null references public.profit_share_settlements(id)
);
alter table public.profit_share_settlements enable row level security;
alter table public.profit_share_items enable row level security;
revoke all on public.profit_share_settlements, public.profit_share_items from anon, authenticated;
grant select on public.profit_share_settlements, public.profit_share_items to authenticated;
drop policy if exists "admins read profit settlements" on public.profit_share_settlements;
create policy "admins read profit settlements" on public.profit_share_settlements
for select to authenticated using ((select public.is_admin()));
drop policy if exists "admins read profit items" on public.profit_share_items;
create policy "admins read profit items" on public.profit_share_items
for select to authenticated using ((select public.is_admin()));

create or replace function public.admin_complete_profit_share(p_item_ids uuid[], p_settings jsonb)
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
  ratio0 numeric;
  ratio1 numeric;
  advances numeric[] := array[0::numeric, 0::numeric];
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
  if jsonb_typeof(parties) is distinct from 'array' or jsonb_array_length(parties) <> 2 then raise exception 'INVALID_PROFIT_SETTINGS'; end if;
  ratio0 := (parties->0->>'ratio')::numeric; ratio1 := (parties->1->>'ratio')::numeric;
  if ratio0 is null or ratio1 is null or ratio0 < 0 or ratio1 < 0 or ratio0 + ratio1 <> 100
    or nullif(trim(parties->0->>'name'), '') is null or nullif(trim(parties->1->>'name'), '') is null
    or trim(parties->0->>'name') = trim(parties->1->>'name')
    or collector is null or collector not in (0, 1) or received is null or received < 0 or received::text in ('NaN', 'Infinity', '-Infinity')
    or (p_settings->>'receivedConfirmed') is distinct from 'true'
    or jsonb_typeof(p_settings->'expenses') is distinct from 'array' then raise exception 'INVALID_PROFIT_SETTINGS'; end if;
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
    if payer is null or payer not in (0, 1) then raise exception 'INVALID_PROFIT_SETTINGS'; end if;
    cost := round(item.effective_cost * item.quantity, 2);
    advances[payer + 1] := advances[payer + 1] + cost;
    item_cost := item_cost + cost; revenue := revenue + round(item.unit_price * item.quantity, 2);
    items := items || jsonb_build_array(jsonb_build_object('id', item.id, 'order_id', item.order_id, 'order_number', item.order_number,
      'recipient', item.recipient_name, 'name', item.product_name, 'quantity', item.quantity,
      'unit_price', item.unit_price, 'unit_cost', item.effective_cost, 'payer', payer));
  end loop;
  for expense in select value from jsonb_array_elements(p_settings->'expenses') loop
    payer := (expense->>'payer')::integer; cost := round((expense->>'amount')::numeric, 2);
    if payer is null or payer not in (0, 1) or cost is null or cost < 0 or cost::text in ('NaN', 'Infinity', '-Infinity')
      or nullif(trim(expense->>'description'), '') is null then raise exception 'INVALID_PROFIT_SETTINGS'; end if;
    advances[payer + 1] := advances[payer + 1] + cost; extra_cost := extra_cost + cost;
    expenses := expenses || jsonb_build_array(jsonb_build_object('description', trim(expense->>'description'), 'amount', cost, 'payer', payer));
  end loop;
  profit := received - item_cost - extra_cost;
  -- 尾數歸第二位，保證兩人的分配總和等於本批利潤。
  shares := array[floor(profit * ratio0 + 0.5) / 100, 0::numeric];
  shares[2] := profit - shares[1];
  for i in 0..1 loop
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

-- 新增確認參數；旧版呼叫仍可用預設 false，已分潤品項必須明確確認。
drop function if exists public.admin_set_shipment_items_completed(uuid[], boolean);
create or replace function public.admin_set_shipment_items_completed(p_order_item_ids uuid[], p_completed boolean, p_acknowledge_profit_share boolean default false)
returns integer language plpgsql security definer set search_path = ''
as $$
declare affected integer;
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if p_completed is null or coalesce(cardinality(p_order_item_ids), 0) = 0 then raise exception 'NO_ITEMS_SELECTED'; end if;
  perform id from public.order_items where id = any(p_order_item_ids) order by id for update;
  perform order_item_id from public.order_item_fulfillments where order_item_id = any(p_order_item_ids) order by order_item_id for update;
  if not p_completed and not coalesce(p_acknowledge_profit_share, false)
    and exists (select 1 from public.profit_share_items where order_item_id = any(p_order_item_ids)) then raise exception 'PROFIT_RESTORE_CONFIRM_REQUIRED'; end if;
  if exists (
    select 1 from unnest(p_order_item_ids) requested(id)
    left join public.order_items item on item.id = requested.id
    left join public.orders o on o.id = item.order_id
    left join public.order_item_fulfillments f on f.order_item_id = item.id
    where requested.id is null or item.id is null or o.status = 'cancelled' or f.shipped_at is null or (f.completed_at is not null) = p_completed
  ) then raise exception 'SHIPMENT_STATE_CHANGED'; end if;
  update public.order_item_fulfillments set completed_at = case when p_completed then now() else null end, updated_by = auth.uid(), updated_at = now()
  where order_item_id = any(p_order_item_ids);
  get diagnostics affected = row_count; return affected;
end;
$$;
drop function if exists public.admin_restore_order_item(uuid);
create or replace function public.admin_restore_order_item(p_order_item_id uuid, p_acknowledge_profit_share boolean default false)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  perform id from public.order_items where id = p_order_item_id for update;
  if not found then raise exception 'ORDER_ITEM_NOT_FOUND'; end if;
  if not coalesce(p_acknowledge_profit_share, false) and exists (select 1 from public.profit_share_items where order_item_id = p_order_item_id) then raise exception 'PROFIT_RESTORE_CONFIRM_REQUIRED'; end if;
  update public.order_item_fulfillments set shipped_at = null, completed_at = null, updated_by = auth.uid(), updated_at = now()
  where order_item_id = p_order_item_id;
end;
$$;
revoke all on function public.admin_complete_profit_share(uuid[], jsonb) from public;
revoke all on function public.admin_set_shipment_items_completed(uuid[], boolean, boolean) from public;
revoke all on function public.admin_restore_order_item(uuid, boolean) from public;
grant execute on function public.admin_complete_profit_share(uuid[], jsonb) to authenticated;
grant execute on function public.admin_set_shipment_items_completed(uuid[], boolean, boolean) to authenticated;
grant execute on function public.admin_restore_order_item(uuid, boolean) to authenticated;
select 'NewShop profit sharing upgrade complete' as result;
commit;
