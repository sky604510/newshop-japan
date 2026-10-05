-- Run after product_cost_upgrade.sql, admin_operations_upgrade.sql and order_editor_upgrade.sql.
-- Existing non-overridden order costs sync from products and all order costs round to whole NTD.

alter table public.order_items
add column if not exists unit_cost_overridden boolean not null default false;

update public.order_items as item
set unit_cost = round(cost.cost, 0)
from public.product_costs as cost
where item.product_id = cost.product_id
  and not item.unit_cost_overridden
  and item.unit_cost is distinct from round(cost.cost, 0);

update public.order_items
set unit_cost = round(unit_cost, 0)
where unit_cost is distinct from round(unit_cost, 0);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'order_items_unit_cost_integer_check' and conrelid = 'public.order_items'::regclass) then
    alter table public.order_items add constraint order_items_unit_cost_integer_check check (unit_cost = trunc(unit_cost));
  end if;
end;
$$;

create or replace function public.snapshot_order_item_cost()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.product_id is not null and not new.unit_cost_overridden then
    select pc.cost into new.unit_cost
    from public.product_costs as pc
    where pc.product_id = new.product_id;
  end if;
  new.unit_cost := round(coalesce(new.unit_cost, 0), 0);
  return new;
end;
$$;

create or replace function public.admin_set_product_costs(
  p_product_id uuid,
  p_foreign_cost numeric,
  p_exchange_rate numeric,
  p_cost numeric,
  p_apply_to_unset_history boolean default true
)
returns numeric
language plpgsql
security definer
set search_path = ''
as $$
declare
  final_cost numeric(12, 2) := coalesce(p_cost, 0);
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if coalesce(p_foreign_cost, 0) < 0 or coalesce(p_exchange_rate, 0) < 0 or final_cost < 0 then
    raise exception 'INVALID_COST';
  end if;
  if final_cost = 0 and coalesce(p_foreign_cost, 0) > 0 and coalesce(p_exchange_rate, 0) > 0 then
    final_cost := round(p_foreign_cost * p_exchange_rate, 2);
  end if;

  insert into public.product_costs (product_id, foreign_cost, exchange_rate, cost)
  values (p_product_id, coalesce(p_foreign_cost, 0), coalesce(p_exchange_rate, 0), final_cost)
  on conflict (product_id) do update set
    foreign_cost = excluded.foreign_cost,
    exchange_rate = excluded.exchange_rate,
    cost = excluded.cost;

  if p_apply_to_unset_history then
    update public.order_items set unit_cost = round(final_cost, 0)
    where product_id = p_product_id and not unit_cost_overridden;
  end if;
  return final_cost;
end;
$$;

create or replace function public.admin_set_product_cost(
  p_product_id uuid,
  p_cost numeric,
  p_apply_to_unset_history boolean default true
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if p_cost is null or p_cost < 0 then raise exception 'INVALID_COST'; end if;

  insert into public.product_costs (product_id, cost)
  values (p_product_id, p_cost)
  on conflict (product_id) do update set cost = excluded.cost;

  if p_apply_to_unset_history then
    update public.order_items set unit_cost = round(p_cost, 0)
    where product_id = p_product_id and not unit_cost_overridden;
  end if;
end;
$$;

create or replace function public.admin_save_order_items(
  p_order_id uuid,
  p_items jsonb,
  p_delivery_method text
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
  item_cost numeric;
  has_cost boolean;
  quantity_delta integer;
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if jsonb_typeof(p_items) <> 'array' then raise exception 'INVALID_ITEMS'; end if;
  if p_delivery_method is null or p_delivery_method not in ('面交取貨', '宅配到府', '7-ELEVEN 貨到付款') then raise exception 'INVALID_DELIVERY_METHOD'; end if;

  perform 1 from public.orders where id = p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;

  for item_data in select value from jsonb_array_elements(p_items)
  loop
    item_id := nullif(item_data->>'id', '')::uuid;
    product_id := nullif(item_data->>'product_id', '')::uuid;
    item_quantity := coalesce((item_data->>'quantity')::integer, 0);
    item_price := coalesce((item_data->>'unit_price')::numeric, 0);
    has_cost := item_data ? 'unit_cost';
    item_cost := case when has_cost then (item_data->>'unit_cost')::numeric else null end;

    if item_quantity < 0 then raise exception 'INVALID_QUANTITY'; end if;
    if item_price < 0 then raise exception 'INVALID_PRICE'; end if;
    if has_cost and (item_cost is null or item_cost < 0 or item_cost <> trunc(item_cost)) then raise exception 'INVALID_COST'; end if;

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
            unit_price = item_price,
            unit_cost = case when has_cost then item_cost else unit_cost end,
            unit_cost_overridden = case when has_cost then true else unit_cost_overridden end
        where id = item_id;
      end if;
    elsif item_quantity > 0 then
      if product_id is null then raise exception 'PRODUCT_REQUIRED'; end if;
      select * into target_product from public.products where id = product_id for update;
      if not found then raise exception 'PRODUCT_NOT_FOUND'; end if;
      if target_product.stock < item_quantity then raise exception 'INSUFFICIENT_STOCK'; end if;

      update public.products set stock = stock - item_quantity where id = product_id;
      insert into public.order_items (order_id, product_id, market_id, product_name, unit_price, unit_cost, unit_cost_overridden, quantity)
      values (p_order_id, target_product.id, target_product.market_id, target_product.name, item_price, coalesce(item_cost, 0), has_cost, item_quantity);
    end if;
  end loop;

  if not exists (select 1 from public.order_items where order_id = p_order_id) then raise exception 'ORDER_EMPTY'; end if;

  update public.orders
  set total_amount = (select coalesce(sum(subtotal), 0) from public.order_items where order_id = p_order_id),
      delivery_method = p_delivery_method,
      updated_at = now()
  where id = p_order_id;

  return p_order_id;
end;
$$;

revoke all on function public.admin_save_order_items(uuid, jsonb, text) from public;
grant execute on function public.admin_save_order_items(uuid, jsonb, text) to authenticated;

select 'NewShop order cost override upgrade complete' as result;
