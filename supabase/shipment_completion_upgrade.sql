-- 發貨清單第三階段。既有 shipped_at 保留，舊「歷史清單」直接成為「已發貨」。
-- 可重複執行；既有資料的 completed_at 預設為 NULL，不會被移入「已完成」。

alter table public.order_item_fulfillments
add column if not exists completed_at timestamptz;

create or replace function public.admin_set_shipment_items_completed(
  p_order_item_ids uuid[],
  p_completed boolean
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected integer;
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if p_completed is null or coalesce(cardinality(p_order_item_ids), 0) = 0 then
    raise exception 'NO_ITEMS_SELECTED';
  end if;

  if exists (
    select 1
    from unnest(p_order_item_ids) as requested(id)
    left join public.order_items as item on item.id = requested.id
    left join public.orders as o on o.id = item.order_id
    left join public.order_item_fulfillments as fulfillment on fulfillment.order_item_id = item.id
    where requested.id is null or item.id is null or o.status = 'cancelled'
      or fulfillment.shipped_at is null
      or (fulfillment.completed_at is not null) = p_completed
  ) then raise exception 'SHIPMENT_STATE_CHANGED'; end if;

  update public.order_item_fulfillments
  set completed_at = case when p_completed then now() else null end,
      updated_by = auth.uid(), updated_at = now()
  where order_item_id = any(p_order_item_ids);

  get diagnostics affected = row_count;
  return affected;
end;
$$;

-- 單品還原至待發貨時，清除已完成標記，避免留下互相矛盾的狀態。
create or replace function public.admin_restore_order_item(p_order_item_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if not exists (select 1 from public.order_items where id = p_order_item_id) then
    raise exception 'ORDER_ITEM_NOT_FOUND';
  end if;

  update public.order_item_fulfillments
  set shipped_at = null, completed_at = null, updated_by = auth.uid(), updated_at = now()
  where order_item_id = p_order_item_id;
end;
$$;

revoke all on function public.admin_set_shipment_items_completed(uuid[], boolean) from public;
grant execute on function public.admin_set_shipment_items_completed(uuid[], boolean) to authenticated;

select 'NewShop shipment completion upgrade complete' as result;
