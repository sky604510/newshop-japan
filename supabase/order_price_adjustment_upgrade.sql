-- NewShop：管理員人工調整訂單商品成交價
-- 保存原始售價，並重新計算訂單總額；可重複執行。

alter table public.order_items
add column if not exists original_unit_price numeric(12, 2);

alter table public.order_items
add column if not exists price_adjusted_at timestamptz;

alter table public.order_items
add column if not exists price_adjusted_by uuid references auth.users(id) on delete set null;

create or replace function public.admin_update_order_item_price(
  p_order_item_id uuid,
  p_unit_price numeric
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_order_id uuid;
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if p_unit_price is null or p_unit_price < 0 then raise exception 'INVALID_PRICE'; end if;

  update public.order_items
  set original_unit_price = coalesce(original_unit_price, unit_price),
      unit_price = p_unit_price,
      price_adjusted_at = now(),
      price_adjusted_by = auth.uid()
  where id = p_order_item_id
  returning order_id into target_order_id;

  if target_order_id is null then raise exception 'ORDER_ITEM_NOT_FOUND'; end if;

  update public.orders
  set total_amount = (
    select coalesce(sum(oi.subtotal), 0)
    from public.order_items as oi
    where oi.order_id = target_order_id
  )
  where id = target_order_id;

  return target_order_id;
end;
$$;

revoke all on function public.admin_update_order_item_price(uuid, numeric) from public;
grant execute on function public.admin_update_order_item_price(uuid, numeric) to authenticated;

select 'NewShop order price adjustment upgrade complete' as result;
