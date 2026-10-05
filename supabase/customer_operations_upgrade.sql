-- NewShop：常客、VIP、管理員代下單、賣場截止日與 7-ELEVEN 貨到付款
-- 可重複執行；不會刪除既有訂單或商品。

create extension if not exists pgcrypto;

alter table public.markets
add column if not exists closes_at timestamptz;

update public.markets
set closes_at = created_at + interval '1 month'
where closes_at is null;

alter table public.markets
alter column closes_at set default (now() + interval '1 month');

alter table public.markets
alter column closes_at set not null;

alter table public.orders
drop constraint if exists orders_delivery_method_check;

alter table public.orders
add constraint orders_delivery_method_check
check (delivery_method in ('面交取貨', '宅配到府', '7-ELEVEN 貨到付款'));

create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users(id) on delete set null,
  email text,
  recipient_name text not null,
  phone text not null,
  delivery_method text not null default '面交取貨'
    check (delivery_method in ('面交取貨', '宅配到府', '7-ELEVEN 貨到付款')),
  is_regular boolean not null default false,
  is_vip boolean not null default false,
  admin_note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.orders
add column if not exists customer_id uuid references public.customers(id) on delete set null;

alter table public.order_items
add column if not exists market_id uuid references public.markets(id) on delete set null;

update public.order_items as oi
set market_id = p.market_id
from public.products as p
where oi.market_id is null and oi.product_id = p.id;

create index if not exists customers_phone_idx on public.customers(phone);
create index if not exists orders_customer_id_idx on public.orders(customer_id);
create index if not exists order_items_market_id_idx on public.order_items(market_id);

drop trigger if exists customers_set_updated_at on public.customers;
create trigger customers_set_updated_at
before update on public.customers
for each row execute function public.set_updated_at();

-- 以每位會員最近一次訂單建立買家資料；既有資料不覆蓋管理員標註。
insert into public.customers (
  auth_user_id, email, recipient_name, phone, delivery_method
)
select distinct on (o.user_id)
  o.user_id,
  u.email,
  o.recipient_name,
  o.phone,
  o.delivery_method
from public.orders as o
join auth.users as u on u.id = o.user_id
order by o.user_id, o.created_at desc
on conflict (auth_user_id) do update set
  email = excluded.email,
  recipient_name = excluded.recipient_name,
  phone = excluded.phone,
  delivery_method = excluded.delivery_method;

update public.orders as o
set customer_id = c.id
from public.customers as c
where o.customer_id is null and c.auth_user_id = o.user_id;

alter table public.customers enable row level security;

revoke all on table public.customers from anon, authenticated;
grant select, insert, update, delete on table public.customers to authenticated;

drop policy if exists "customers read own record" on public.customers;
create policy "customers read own record"
on public.customers for select to authenticated
using (auth_user_id = (select auth.uid()));

drop policy if exists "admins read all customers" on public.customers;
create policy "admins read all customers"
on public.customers for select to authenticated
using ((select public.is_admin()));

drop policy if exists "admins insert customers" on public.customers;
create policy "admins insert customers"
on public.customers for insert to authenticated
with check ((select public.is_admin()));

drop policy if exists "admins update customers" on public.customers;
create policy "admins update customers"
on public.customers for update to authenticated
using ((select public.is_admin()))
with check ((select public.is_admin()));

drop policy if exists "admins delete customers" on public.customers;
create policy "admins delete customers"
on public.customers for delete to authenticated
using ((select public.is_admin()));

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

select 'NewShop customer operations upgrade complete' as result;
