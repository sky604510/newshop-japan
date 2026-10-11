-- NewShop：後台訂單整筆編輯與新增商品
-- 執行後，管理員可在同一個跳窗修改數量、成交價，或由賣場加入新商品。
-- 可重複執行，不會變更既有訂單內容。

alter table public.order_items add column if not exists market_id uuid references public.markets(id) on delete set null;
alter table public.order_items add column if not exists unit_cost numeric(12, 2) not null default 0 check (unit_cost >= 0);
alter table public.order_items add column if not exists original_unit_price numeric(12, 2);
alter table public.order_items add column if not exists price_adjusted_at timestamptz;
alter table public.order_items add column if not exists price_adjusted_by uuid references auth.users(id) on delete set null;

create or replace function public.admin_save_order_items(
  p_order_id uuid,
  p_items jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  item_data jsonb;
  target_item public.order_items%rowtype;
  target_product public.products%rowtype;
  item_id uuid;
  product_id uuid;
  item_quantity integer;
  item_price numeric(12, 2);
  quantity_delta integer;
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if jsonb_typeof(p_items) <> 'array' then raise exception 'INVALID_ITEMS'; end if;

  perform 1 from public.orders where id = p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;

  for item_data in select value from jsonb_array_elements(p_items)
  loop
    item_id := nullif(item_data->>'id', '')::uuid;
    product_id := nullif(item_data->>'product_id', '')::uuid;
    item_quantity := coalesce((item_data->>'quantity')::integer, 0);
    item_price := coalesce((item_data->>'unit_price')::numeric, 0);

    if item_quantity < 0 then raise exception 'INVALID_QUANTITY'; end if;
    if item_price < 0 then raise exception 'INVALID_PRICE'; end if;

    if item_id is not null then
      select * into target_item
      from public.order_items
      where id = item_id and order_id = p_order_id
      for update;
      if not found then raise exception 'ORDER_ITEM_NOT_FOUND'; end if;

      quantity_delta := item_quantity - target_item.quantity;
      if target_item.product_id is not null and quantity_delta <> 0 then
        select * into target_product from public.products where id = target_item.product_id for update;
        if quantity_delta > 0 and target_product.stock < quantity_delta then raise exception 'INSUFFICIENT_STOCK'; end if;
        update public.products set stock = stock - quantity_delta where id = target_item.product_id;
      end if;

      if item_quantity = 0 then
        delete from public.order_items where id = item_id;
      else
        update public.order_items
        set quantity = item_quantity,
            original_unit_price = case when item_price is distinct from unit_price then coalesce(original_unit_price, unit_price) else original_unit_price end,
            price_adjusted_at = case when item_price is distinct from unit_price then now() else price_adjusted_at end,
            price_adjusted_by = case when item_price is distinct from unit_price then auth.uid() else price_adjusted_by end,
            unit_price = item_price
        where id = item_id;
      end if;
    elsif item_quantity > 0 then
      if product_id is null then raise exception 'PRODUCT_REQUIRED'; end if;
      select * into target_product from public.products where id = product_id for update;
      if not found then raise exception 'PRODUCT_NOT_FOUND'; end if;
      if target_product.stock < item_quantity then raise exception 'INSUFFICIENT_STOCK'; end if;

      update public.products set stock = stock - item_quantity where id = product_id;
      insert into public.order_items (order_id, product_id, market_id, product_name, unit_price, quantity)
      values (p_order_id, target_product.id, target_product.market_id, target_product.name, item_price, item_quantity);
    end if;
  end loop;

  if not exists (select 1 from public.order_items where order_id = p_order_id) then
    raise exception 'ORDER_EMPTY';
  end if;

  update public.orders
  set total_amount = (select coalesce(sum(subtotal), 0) from public.order_items where order_id = p_order_id),
      updated_at = now()
  where id = p_order_id;

  return p_order_id;
end;
$$;

revoke all on function public.admin_save_order_items(uuid, jsonb) from public;
grant execute on function public.admin_save_order_items(uuid, jsonb) to authenticated;

select 'NewShop order editor upgrade complete' as result;
