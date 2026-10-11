-- Run after the existing admin operations and profit-sharing v2 upgrades.
begin;
alter table public.procurement_checks add column if not exists cost_allocations jsonb not null default '{}'::jsonb;

create or replace function public.admin_set_procurement_cost_people(p_records jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare r jsonb; i record; a jsonb; keys_count integer;
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if jsonb_typeof(p_records) <> 'array' or jsonb_array_length(p_records) = 0 then raise exception 'INVALID_COST_ALLOCATION'; end if;
  for r in select value from jsonb_array_elements(p_records) loop
    if jsonb_typeof(r->'cost_allocations') <> 'object' then raise exception 'INVALID_COST_ALLOCATION'; end if;
    keys_count := 0;
    for i in select oi.id, oi.quantity from public.order_items oi join public.orders o on o.id = oi.order_id
      where oi.product_id = (r->>'product_id')::uuid and o.status <> 'cancelled' order by oi.id for update of oi loop
      a := r->'cost_allocations'->i.id::text;
      if a is null or jsonb_typeof(a) <> 'array' or jsonb_array_length(a) <> 2
        or not coalesce(a->>0 ~ '^[0-9]+$' and a->>1 ~ '^[0-9]+$', false)
        or (a->>0)::numeric + (a->>1)::numeric <> i.quantity then raise exception 'INVALID_COST_ALLOCATION'; end if;
      keys_count := keys_count + 1;
    end loop;
    if keys_count = 0 or keys_count <> (select count(*) from jsonb_object_keys(r->'cost_allocations')) then raise exception 'COST_QUANTITY_CHANGED'; end if;
    insert into public.procurement_checks(product_id, cost_allocations, updated_by, updated_at)
      values ((r->>'product_id')::uuid, r->'cost_allocations', auth.uid(), now())
      on conflict(product_id) do update set cost_allocations = excluded.cost_allocations, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  end loop;
end $$;
revoke all on function public.admin_set_procurement_cost_people(jsonb) from public, anon;
grant execute on function public.admin_set_procurement_cost_people(jsonb) to authenticated;

-- v2 remains responsible for amount checks, completed-item eligibility,
-- duplicate settlement prevention and profit rounding. Only reimbursements change.
create or replace function public.admin_complete_profit_share_v3(p_item_ids uuid[], p_settings jsonb)
returns setof public.profit_share_settlements language plpgsql security definer set search_path = public as $$
declare i record; a jsonb; saved record; snapshot_value jsonb; entry jsonb; party jsonb;
  original numeric[] := array[0::numeric, 0::numeric]; allocated numeric[] := array[0::numeric, 0::numeric];
  item_total numeric; first_total numeric; idx integer; advance_value numeric; items_value jsonb := '[]'; parties_value jsonb := '[]';
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if jsonb_array_length(p_settings->'parties') is distinct from 2 or (p_settings->'parties'->0->>'name') is distinct from '豪'
    or (p_settings->'parties'->1->>'name') is distinct from '盈' then raise exception 'INVALID_PROFIT_SETTINGS'; end if;
  -- Lock order items first, matching procurement saves, then allocation records.
  perform id from public.order_items where id = any(p_item_ids) order by id for update;
  perform pc.product_id from public.procurement_checks pc where pc.product_id in
    (select product_id from public.order_items where id = any(p_item_ids)) order by pc.product_id for share;
  for i in select oi.id, oi.quantity, pc.cost_allocations from public.order_items oi
    left join public.procurement_checks pc on pc.product_id = oi.product_id where oi.id = any(p_item_ids) loop
    a := i.cost_allocations->i.id::text;
    if a is null or jsonb_typeof(a) <> 'array' or jsonb_array_length(a) <> 2
      or not coalesce(a->>0 ~ '^[0-9]+$' and a->>1 ~ '^[0-9]+$', false)
      or (a->>0)::numeric + (a->>1)::numeric <> i.quantity
      or a is distinct from p_settings->'allocations'->i.id::text then raise exception 'PROFIT_COST_ALLOCATION_CHANGED'; end if;
  end loop;
  select * into saved from public.admin_complete_profit_share_v2(p_item_ids, p_settings);
  snapshot_value := saved.snapshot;
  for entry in select value from jsonb_array_elements(snapshot_value->'items') loop
    a := p_settings->'allocations'->(entry->>'id');
    item_total := round((entry->>'unit_cost')::numeric * (entry->>'quantity')::numeric, 2);
    first_total := round((entry->>'unit_cost')::numeric * (a->>0)::numeric, 2);
    idx := (entry->>'payer')::integer + 1;
    original[idx] := original[idx] + item_total;
    allocated[1] := allocated[1] + first_total; allocated[2] := allocated[2] + item_total - first_total;
    items_value := items_value || jsonb_build_array(entry || jsonb_build_object('allocation', a));
  end loop;
  idx := 1;
  for party in select value from jsonb_array_elements(snapshot_value->'parties') loop
    advance_value := (party->>'advance')::numeric - original[idx] + allocated[idx];
    parties_value := parties_value || jsonb_build_array(party || jsonb_build_object('advance', advance_value,
      'balance', advance_value + (party->>'share')::numeric - case when idx - 1 = (snapshot_value->>'collector')::integer then (snapshot_value->>'received')::numeric else 0 end));
    idx := idx + 1;
  end loop;
  snapshot_value := snapshot_value || jsonb_build_object('items', items_value, 'parties', parties_value);
  return query update public.profit_share_settlements set snapshot = snapshot_value where id = saved.id returning *;
end $$;
revoke all on function public.admin_complete_profit_share_v3(uuid[], jsonb) from public, anon;
grant execute on function public.admin_complete_profit_share_v3(uuid[], jsonb) to authenticated;
notify pgrst, 'reload schema';
commit;
