-- NewShop 日本連線代購：Supabase 初始資料庫
-- 可重複執行；既有資料不會被刪除。

create extension if not exists pgcrypto;

-- 會員資料：密碼由 Supabase Auth 保存，這裡只放公開會員資訊與權限。
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique check (char_length(username) between 2 and 40),
  display_name text,
  role text not null default 'customer' check (role in ('customer', 'admin', 'owner')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 舊版資料庫也要擴充角色約束。
alter table public.profiles
drop constraint if exists profiles_role_check;

alter table public.profiles
add constraint profiles_role_check
check (role in ('customer', 'admin', 'owner'));

-- 賣場／商品類別：一個賣場可以包含多個品項。
create table if not exists public.markets (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique default replace(gen_random_uuid()::text, '-', ''),
  name text not null check (char_length(trim(name)) between 1 and 100),
  description text not null default '',
  image_url text,
  is_active boolean not null default true,
  is_pinned boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 品項：每個品項有獨立價格與庫存。
create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  market_id uuid not null references public.markets(id) on delete restrict,
  name text not null,
  description text not null default '',
  price numeric(12, 2) not null check (price >= 0),
  image_url text,
  stock integer not null default 0 check (stock >= 0),
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 訂單主檔。
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique default (
    'NS-' || to_char(current_date, 'YYMMDD') || '-' ||
    upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6))
  ),
  user_id uuid not null default auth.uid() references auth.users(id) on delete restrict,
  recipient_name text not null,
  phone text not null,
  delivery_method text not null check (delivery_method in ('面交取貨', '宅配到府')),
  note text not null default '',
  status text not null default 'pending'
    check (status in ('pending', 'confirmed', 'preparing', 'shipped', 'completed', 'cancelled')),
  total_amount numeric(12, 2) not null default 0 check (total_amount >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 訂單明細：保存下單當時的品名與單價，商品日後改價不影響舊訂單。
create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  product_name text not null,
  unit_price numeric(12, 2) not null check (unit_price >= 0),
  quantity integer not null check (quantity > 0),
  subtotal numeric(12, 2) generated always as (unit_price * quantity) stored,
  created_at timestamptz not null default now()
);

create index if not exists orders_user_id_idx on public.orders(user_id);
create index if not exists orders_created_at_idx on public.orders(created_at desc);
create index if not exists order_items_order_id_idx on public.order_items(order_id);
create index if not exists products_market_id_idx on public.products(market_id, created_at);

-- 自動更新 updated_at。
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

drop trigger if exists products_set_updated_at on public.products;
create trigger products_set_updated_at
before update on public.products
for each row execute function public.set_updated_at();

drop trigger if exists markets_set_updated_at on public.markets;
create trigger markets_set_updated_at
before update on public.markets
for each row execute function public.set_updated_at();

drop trigger if exists orders_set_updated_at on public.orders;
create trigger orders_set_updated_at
before update on public.orders
for each row execute function public.set_updated_at();

-- 新會員註冊後自動建立 profile。
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested_username text;
  requested_role text := 'customer';
begin
  requested_username := lower(trim(coalesce(
    new.raw_user_meta_data ->> 'username',
    new.raw_user_meta_data ->> 'account',
    split_part(new.email, '@', 1)
  )));

  if requested_username is null or char_length(requested_username) < 2 then
    requested_username := 'user_' || substr(new.id::text, 1, 8);
  end if;

  requested_username := left(requested_username, 40);

  if exists (select 1 from public.profiles where username = requested_username) then
    requested_username := left(requested_username, 31) || '_' || substr(new.id::text, 1, 8);
  end if;

  if new.email_confirmed_at is not null
    and lower(trim(new.email)) in ('sky604510@gmail.com', 'kame2937@gmail.com') then
    requested_role := 'owner';
  end if;

  insert into public.profiles (id, username, display_name, role)
  values (
    new.id,
    requested_username,
    nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
    requested_role
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- 開啟信箱驗證時，在使用者點擊確認信後才授予最高所有者權限。
create or replace function public.sync_verified_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.email_confirmed_at is not null
    and lower(trim(new.email)) in ('sky604510@gmail.com', 'kame2937@gmail.com') then
    update public.profiles set role = 'owner' where id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_owner_verified on auth.users;
create trigger on_auth_owner_verified
after update of email_confirmed_at, email on auth.users
for each row execute function public.sync_verified_owner();

-- 供 RLS 判斷管理員；一般使用者無法自行修改 role 欄位。
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles
    where id = (select auth.uid()) and role in ('admin', 'owner')
  );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- 安全下單：由資料庫讀取真實價格、扣庫存並計算總額。
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
  new_order_id uuid;
  item_record record;
  selected_product public.products%rowtype;
  calculated_total numeric(12, 2) := 0;
begin
  if current_user_id is null then
    raise exception 'LOGIN_REQUIRED';
  end if;

  if trim(coalesce(p_recipient_name, '')) = '' then
    raise exception 'RECIPIENT_REQUIRED';
  end if;

  if p_delivery_method not in ('面交取貨', '宅配到府') then
    raise exception 'INVALID_DELIVERY_METHOD';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'EMPTY_CART';
  end if;

  insert into public.orders (
    user_id, recipient_name, phone, delivery_method, note
  ) values (
    current_user_id, trim(p_recipient_name), trim(coalesce(p_phone, '')),
    p_delivery_method, trim(coalesce(p_note, ''))
  ) returning id into new_order_id;

  for item_record in
    select product_id, quantity
    from jsonb_to_recordset(p_items) as x(product_id uuid, quantity integer)
  loop
    if item_record.quantity is null or item_record.quantity <= 0 then
      raise exception 'INVALID_QUANTITY';
    end if;

    select * into selected_product
    from public.products
    where id = item_record.product_id and is_active = true
    for update;

    if not found then
      raise exception 'PRODUCT_NOT_AVAILABLE';
    end if;

    if selected_product.stock < item_record.quantity then
      raise exception 'INSUFFICIENT_STOCK: %', selected_product.name;
    end if;

    update public.products
    set stock = stock - item_record.quantity
    where id = selected_product.id;

    insert into public.order_items (
      order_id, product_id, product_name, unit_price, quantity
    ) values (
      new_order_id, selected_product.id, selected_product.name,
      selected_product.price, item_record.quantity
    );

    calculated_total := calculated_total + selected_product.price * item_record.quantity;
  end loop;

  update public.orders
  set total_amount = calculated_total
  where id = new_order_id;

  return new_order_id;
end;
$$;

revoke all on function public.place_order(text, text, text, text, jsonb) from public;
grant execute on function public.place_order(text, text, text, text, jsonb) to authenticated;

-- 啟用 RLS。
alter table public.profiles enable row level security;
alter table public.markets enable row level security;
alter table public.products enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;

-- 先清除預設權限，再只開放網站需要的最小權限。
revoke all on table public.profiles from anon, authenticated;
revoke all on table public.markets from anon, authenticated;
revoke all on table public.products from anon, authenticated;
revoke all on table public.orders from anon, authenticated;
revoke all on table public.order_items from anon, authenticated;

grant select on table public.profiles to authenticated;
grant update (username, display_name) on table public.profiles to authenticated;

grant select on table public.markets to anon, authenticated;
grant insert, update, delete on table public.markets to authenticated;

grant select on table public.products to anon, authenticated;
grant insert, update, delete on table public.products to authenticated;

grant select on table public.orders to authenticated;
grant update (status) on table public.orders to authenticated;
grant select on table public.order_items to authenticated;

-- 商品圖片：公開讀取，僅店主可上傳、更新或刪除。
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'product-images', 'product-images', true, 5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "managers upload product images" on storage.objects;
create policy "managers upload product images"
on storage.objects for insert to authenticated
with check (bucket_id = 'product-images' and (select public.is_admin()));

drop policy if exists "managers update product images" on storage.objects;
create policy "managers update product images"
on storage.objects for update to authenticated
using (bucket_id = 'product-images' and (select public.is_admin()))
with check (bucket_id = 'product-images' and (select public.is_admin()));

drop policy if exists "managers delete product images" on storage.objects;
create policy "managers delete product images"
on storage.objects for delete to authenticated
using (bucket_id = 'product-images' and (select public.is_admin()));

-- Profiles policies。
drop policy if exists "users read own profile" on public.profiles;
create policy "users read own profile"
on public.profiles for select to authenticated
using ((select auth.uid()) = id);

drop policy if exists "admins read all profiles" on public.profiles;
create policy "admins read all profiles"
on public.profiles for select to authenticated
using ((select public.is_admin()));

drop policy if exists "users update own profile" on public.profiles;
create policy "users update own profile"
on public.profiles for update to authenticated
using ((select auth.uid()) = id)
with check ((select auth.uid()) = id);

-- Markets policies。
drop policy if exists "public reads active markets" on public.markets;
create policy "public reads active markets"
on public.markets for select to anon, authenticated
using (is_active = true);

drop policy if exists "admins read all markets" on public.markets;
create policy "admins read all markets"
on public.markets for select to authenticated
using ((select public.is_admin()));

drop policy if exists "admins insert markets" on public.markets;
create policy "admins insert markets"
on public.markets for insert to authenticated
with check ((select public.is_admin()));

drop policy if exists "admins update markets" on public.markets;
create policy "admins update markets"
on public.markets for update to authenticated
using ((select public.is_admin()))
with check ((select public.is_admin()));

drop policy if exists "admins delete markets" on public.markets;
create policy "admins delete markets"
on public.markets for delete to authenticated
using ((select public.is_admin()));

-- Products policies。
drop policy if exists "public reads active products" on public.products;
create policy "public reads active products"
on public.products for select to anon, authenticated
using (
  is_active = true and exists (
    select 1 from public.markets as m
    where m.id = products.market_id and m.is_active = true
  )
);

drop policy if exists "admins read all products" on public.products;
create policy "admins read all products"
on public.products for select to authenticated
using ((select public.is_admin()));

drop policy if exists "admins insert products" on public.products;
create policy "admins insert products"
on public.products for insert to authenticated
with check ((select public.is_admin()));

drop policy if exists "admins update products" on public.products;
create policy "admins update products"
on public.products for update to authenticated
using ((select public.is_admin()))
with check ((select public.is_admin()));

drop policy if exists "admins delete products" on public.products;
create policy "admins delete products"
on public.products for delete to authenticated
using ((select public.is_admin()));

-- Orders policies。
drop policy if exists "users read own orders" on public.orders;
create policy "users read own orders"
on public.orders for select to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "admins read all orders" on public.orders;
create policy "admins read all orders"
on public.orders for select to authenticated
using ((select public.is_admin()));

drop policy if exists "admins update order status" on public.orders;
create policy "admins update order status"
on public.orders for update to authenticated
using ((select public.is_admin()))
with check ((select public.is_admin()));

-- Order item policies。
drop policy if exists "users read own order items" on public.order_items;
create policy "users read own order items"
on public.order_items for select to authenticated
using (
  exists (
    select 1 from public.orders
    where orders.id = order_items.order_id
      and orders.user_id = (select auth.uid())
  )
);

drop policy if exists "admins read all order items" on public.order_items;
create policy "admins read all order items"
on public.order_items for select to authenticated
using ((select public.is_admin()));

-- 指定的兩個店主信箱為最高所有者；對既有帳號也會生效。
insert into public.profiles (id, username, role)
select u.id, 'owner_' || substr(u.id::text, 1, 8), 'owner'
from auth.users as u
left join public.profiles as p on p.id = u.id
where p.id is null
  and u.email_confirmed_at is not null
  and lower(u.email) in ('sky604510@gmail.com', 'kame2937@gmail.com')
on conflict (id) do nothing;

update public.profiles as p
set role = 'owner'
from auth.users as u
where p.id = u.id
  and u.email_confirmed_at is not null
  and lower(u.email) in ('sky604510@gmail.com', 'kame2937@gmail.com');

-- 預設「零售區」，既有或少量現貨品項可放在這裡。
insert into public.markets (slug, name, description, is_active, sort_order)
values ('retail', '零售區', '少量現貨與單品代購，可直接選擇品項下單。', true, 0)
on conflict (slug) do update set name = excluded.name;

-- 三個展示品項，可稍後在後台修改。
insert into public.products (market_id, name, description, price, stock)
select (select id from public.markets where slug = 'retail'), '日本限定零食箱', '日本當地人氣零食，每批內容依連線採購調整。', 680, 20
where not exists (select 1 from public.products where name = '日本限定零食箱');

insert into public.products (market_id, name, description, price, stock)
select (select id from public.markets where slug = 'retail'), '日本藥妝代購', '下單後由店主確認品牌、規格與實際價格。', 390, 20
where not exists (select 1 from public.products where name = '日本藥妝代購');

insert into public.products (market_id, name, description, price, stock)
select (select id from public.markets where slug = 'retail'), '日本生活雜貨', '精選日本日用品與期間限定商品。', 520, 20
where not exists (select 1 from public.products where name = '日本生活雜貨');

-- 完成。上述兩個指定信箱註冊後會自動成為最高所有者。
