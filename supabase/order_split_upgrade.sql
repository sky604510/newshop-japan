-- NewShop：管理員將訂單中的整筆品項移到新訂單。
-- 在 Supabase SQL Editor 執行一次；需先有 admin_operations_upgrade.sql。
-- 不新增或刪除商品品項、不異動庫存；品項 ID 與採購／發貨紀錄保持不變。

create or replace function public.admin_split_order_items(
  p_order_id uuid,
  p_order_item_ids uuid[]
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  source_order public.orders%rowtype;
  new_order_id uuid;
  new_order_number text;
  total_items integer;
  selected_items integer;
  moved_items integer;
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if coalesce(pg_catalog.cardinality(p_order_item_ids), 0) = 0 then raise exception 'NO_ITEMS_SELECTED'; end if;

  select * into source_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if source_order.status = 'cancelled' then raise exception 'ORDER_CANCELLED'; end if;

  perform 1 from public.order_items where order_id = p_order_id for update;
  select count(*) into total_items from public.order_items where order_id = p_order_id;
  select count(distinct requested.id) into selected_items from unnest(p_order_item_ids) as requested(id);
  if selected_items <> pg_catalog.cardinality(p_order_item_ids) then raise exception 'DUPLICATE_OR_INVALID_ITEM'; end if;
  if exists (
    select 1 from unnest(p_order_item_ids) as requested(id)
    left join public.order_items as item on item.id = requested.id and item.order_id = p_order_id
    where item.id is null
  ) then raise exception 'ORDER_ITEM_NOT_FOUND'; end if;
  if selected_items >= total_items then raise exception 'ORIGINAL_ORDER_EMPTY'; end if;

  insert into public.orders (
    user_id, account_email, customer_id, recipient_name, phone,
    delivery_method, note, status, total_amount
  ) values (
    source_order.user_id, source_order.account_email, source_order.customer_id,
    source_order.recipient_name, source_order.phone, source_order.delivery_method,
    source_order.note, source_order.status, 0
  ) returning id, order_number into new_order_id, new_order_number;

  update public.order_items
  set order_id = new_order_id
  where order_id = p_order_id and id = any(p_order_item_ids);
  get diagnostics moved_items = row_count;
  if moved_items <> selected_items then raise exception 'ORDER_ITEMS_CHANGED'; end if;

  update public.orders
  set total_amount = (select coalesce(sum(subtotal), 0) from public.order_items where order_id = p_order_id),
      updated_at = now()
  where id = p_order_id;
  update public.orders
  set total_amount = (select coalesce(sum(subtotal), 0) from public.order_items where order_id = new_order_id),
      updated_at = now()
  where id = new_order_id;

  return new_order_number;
end;
$$;

revoke all on function public.admin_split_order_items(uuid, uuid[]) from public;
grant execute on function public.admin_split_order_items(uuid, uuid[]) to authenticated;

select 'NewShop order split upgrade complete' as result;
