-- 先執行 shipment_reconciliation_upgrade.sql；此檔可重複執行。
-- 僅為已對帳資料補上批次，不會把待收款資料提升為已完成。
begin;
alter table public.order_item_fulfillments add column if not exists reconciliation_batch_id uuid;
with batches as (
  select reconciled_at, gen_random_uuid() as id
  from public.order_item_fulfillments
  where reconciled_at is not null and reconciliation_batch_id is null
  group by reconciled_at
)
update public.order_item_fulfillments f set reconciliation_batch_id = b.id
from batches b where f.reconciled_at = b.reconciled_at and f.reconciliation_batch_id is null;
create index if not exists order_item_fulfillments_reconciliation_batch_idx
on public.order_item_fulfillments(reconciliation_batch_id) where reconciliation_batch_id is not null;

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
  update public.order_item_fulfillments set completed_at = case when p_completed then now() else null end, reconciled_at = null, reconciliation_batch_id = null, updated_by = auth.uid(), updated_at = now()
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
  update public.order_item_fulfillments set shipped_at = null, completed_at = null, reconciled_at = null, reconciliation_batch_id = null, updated_by = auth.uid(), updated_at = now()
  where order_item_id = p_order_item_id;
end;
$$;

create or replace function public.admin_reconcile_shipment_items(
  p_order_item_ids uuid[], p_reconciled boolean, p_acknowledge_profit_share boolean default false
) returns integer language plpgsql security definer set search_path = ''
as $$
declare affected integer; batch uuid := gen_random_uuid();
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if p_reconciled is null or coalesce(cardinality(p_order_item_ids), 0) = 0
    or cardinality(p_order_item_ids) <> (select count(distinct id) from unnest(p_order_item_ids) id)
    then raise exception 'NO_ITEMS_SELECTED'; end if;
  perform id from public.order_items where id = any(p_order_item_ids) order by id for update;
  perform order_item_id from public.order_item_fulfillments where order_item_id = any(p_order_item_ids) order by order_item_id for update;
  if not p_reconciled and not coalesce(p_acknowledge_profit_share, false)
    and exists (select 1 from public.profit_share_items where order_item_id = any(p_order_item_ids))
    then raise exception 'PROFIT_RESTORE_CONFIRM_REQUIRED'; end if;
  if exists (
    select 1 from unnest(p_order_item_ids) requested(id)
    left join public.order_items item on item.id = requested.id
    left join public.orders o on o.id = item.order_id
    left join public.order_item_fulfillments f on f.order_item_id = item.id
    where requested.id is null or item.id is null or o.status = 'cancelled'
      or f.shipped_at is null or f.completed_at is null
      or (f.reconciled_at is not null) = p_reconciled
  ) then raise exception 'SHIPMENT_STATE_CHANGED'; end if;
  update public.order_item_fulfillments
  set reconciled_at = case when p_reconciled then now() else null end,
    reconciliation_batch_id = case when p_reconciled then batch else null end, updated_by = auth.uid(), updated_at = now()
  where order_item_id = any(p_order_item_ids);
  get diagnostics affected = row_count; return affected;
end;
$$;
revoke all on function public.admin_reconcile_shipment_items(uuid[], boolean, boolean) from public;
grant execute on function public.admin_reconcile_shipment_items(uuid[], boolean, boolean) to authenticated;
revoke all on function public.admin_set_shipment_items_completed(uuid[], boolean, boolean) from public;
revoke all on function public.admin_restore_order_item(uuid, boolean) from public;
grant execute on function public.admin_set_shipment_items_completed(uuid[], boolean, boolean) to authenticated;
grant execute on function public.admin_restore_order_item(uuid, boolean) to authenticated;
commit;
