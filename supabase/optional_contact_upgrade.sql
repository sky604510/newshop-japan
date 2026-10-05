-- NewShop：讓訂單聯絡電話可留空（只有收件人必填）
-- 已執行過 customer_operations_upgrade.sql 的專案，只需執行本檔。

create or replace function public.place_order(
  p_recipient_name text,
  p_phone text,
  p_delivery_method text,
  p_note text,
  p_items jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  current_customer_id uuid;
  current_email text;
  new_order_id uuid;
  item_record record;
  selected_product public.products%rowtype;
  calculated_total numeric(12, 2) := 0;
begin
  if current_user_id is null then raise exception 'LOGIN_REQUIRED'; end if;
  if trim(coalesce(p_recipient_name, '')) = '' then
    raise exception 'RECIPIENT_REQUIRED';
  end if;
  if p_delivery_method not in ('面交取貨', '宅配到府', '7-ELEVEN 貨到付款') then
    raise exception 'INVALID_DELIVERY_METHOD';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'EMPTY_CART';
  end if;

  select email into current_email from auth.users where id = current_user_id;
  insert into public.customers (auth_user_id, email, recipient_name, phone, delivery_method)
  values (current_user_id, current_email, trim(p_recipient_name), trim(coalesce(p_phone, '')), p_delivery_method)
  on conflict (auth_user_id) do update set
    email = excluded.email,
    recipient_name = excluded.recipient_name,
    phone = excluded.phone,
    delivery_method = excluded.delivery_method
  returning id into current_customer_id;

  insert into public.orders (
    user_id, customer_id, recipient_name, phone, delivery_method, note
  ) values (
    current_user_id, current_customer_id, trim(p_recipient_name), trim(coalesce(p_phone, '')),
    p_delivery_method, trim(coalesce(p_note, ''))
  ) returning id into new_order_id;

  for item_record in
    select product_id, quantity
    from jsonb_to_recordset(p_items) as x(product_id uuid, quantity integer)
  loop
    if item_record.quantity is null or item_record.quantity <= 0 then raise exception 'INVALID_QUANTITY'; end if;
    select * into selected_product from public.products
    where id = item_record.product_id and is_active = true for update;
    if not found then raise exception 'PRODUCT_NOT_AVAILABLE'; end if;
    if selected_product.stock < item_record.quantity then
      raise exception 'INSUFFICIENT_STOCK: %', selected_product.name;
    end if;
    update public.products set stock = stock - item_record.quantity where id = selected_product.id;
    insert into public.order_items (order_id, product_id, market_id, product_name, unit_price, quantity)
    values (new_order_id, selected_product.id, selected_product.market_id, selected_product.name, selected_product.price, item_record.quantity);
    calculated_total := calculated_total + selected_product.price * item_record.quantity;
  end loop;

  update public.orders set total_amount = calculated_total where id = new_order_id;
  return new_order_id;
end;
$$;

revoke all on function public.place_order(text, text, text, text, jsonb) from public;
grant execute on function public.place_order(text, text, text, text, jsonb) to authenticated;

create or replace function public.admin_place_order(
  p_customer_id uuid,
  p_recipient_name text,
  p_phone text,
  p_delivery_method text,
  p_note text,
  p_items jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  admin_user_id uuid := auth.uid();
  target_customer_id uuid := p_customer_id;
  target_user_id uuid;
  new_order_id uuid;
  item_record record;
  selected_product public.products%rowtype;
  calculated_total numeric(12, 2) := 0;
begin
  if admin_user_id is null or not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if trim(coalesce(p_recipient_name, '')) = '' then
    raise exception 'RECIPIENT_REQUIRED';
  end if;
  if p_delivery_method not in ('面交取貨', '宅配到府', '7-ELEVEN 貨到付款') then
    raise exception 'INVALID_DELIVERY_METHOD';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'EMPTY_CART';
  end if;

  if target_customer_id is null then
    insert into public.customers (recipient_name, phone, delivery_method)
    values (trim(p_recipient_name), trim(coalesce(p_phone, '')), p_delivery_method)
    returning id into target_customer_id;
    target_user_id := admin_user_id;
  else
    select coalesce(auth_user_id, admin_user_id) into target_user_id
    from public.customers where id = target_customer_id;
    if not found then raise exception 'CUSTOMER_NOT_FOUND'; end if;
  end if;

  update public.customers set
    recipient_name = trim(p_recipient_name), phone = trim(coalesce(p_phone, '')), delivery_method = p_delivery_method
  where id = target_customer_id;

  insert into public.orders (
    user_id, customer_id, recipient_name, phone, delivery_method, note
  ) values (
    target_user_id, target_customer_id, trim(p_recipient_name), trim(coalesce(p_phone, '')),
    p_delivery_method, trim(coalesce(p_note, ''))
  ) returning id into new_order_id;

  for item_record in
    select product_id, quantity
    from jsonb_to_recordset(p_items) as x(product_id uuid, quantity integer)
  loop
    if item_record.quantity is null or item_record.quantity <= 0 then raise exception 'INVALID_QUANTITY'; end if;
    select * into selected_product from public.products
    where id = item_record.product_id and is_active = true for update;
    if not found then raise exception 'PRODUCT_NOT_AVAILABLE'; end if;
    if selected_product.stock < item_record.quantity then
      raise exception 'INSUFFICIENT_STOCK: %', selected_product.name;
    end if;
    update public.products set stock = stock - item_record.quantity where id = selected_product.id;
    insert into public.order_items (order_id, product_id, market_id, product_name, unit_price, quantity)
    values (new_order_id, selected_product.id, selected_product.market_id, selected_product.name, selected_product.price, item_record.quantity);
    calculated_total := calculated_total + selected_product.price * item_record.quantity;
  end loop;

  update public.orders set total_amount = calculated_total where id = new_order_id;
  return new_order_id;
end;
$$;

revoke all on function public.admin_place_order(uuid, text, text, text, text, jsonb) from public;
grant execute on function public.admin_place_order(uuid, text, text, text, text, jsonb) to authenticated;

select 'NewShop optional contact upgrade complete' as result;

