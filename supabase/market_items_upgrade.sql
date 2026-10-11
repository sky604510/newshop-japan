-- NewShop 賣場／多品項升級
-- 結構：賣場（商品類別） -> 多個品項（各自價格與庫存）
-- 在 Supabase SQL Editor 完整執行一次。不會刪除現有商品或訂單。

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

drop trigger if exists markets_set_updated_at on public.markets;
create trigger markets_set_updated_at
before update on public.markets
for each row execute function public.set_updated_at();

alter table public.products
add column if not exists market_id uuid references public.markets(id) on delete restrict;

alter table public.products
add column if not exists sort_order integer not null default 0;

create index if not exists products_market_id_idx
on public.products(market_id, created_at);

-- 現有商品全部放入「零售區」。
insert into public.markets (slug, name, description, is_active, sort_order)
values ('retail', '零售區', '少量現貨與單品代購，可直接選擇品項下單。', true, 0)
on conflict (slug) do update set name = excluded.name;

update public.products
set market_id = (select id from public.markets where slug = 'retail')
where market_id is null;

alter table public.products
alter column market_id set not null;

alter table public.markets enable row level security;
revoke all on table public.markets from anon, authenticated;
grant select on table public.markets to anon, authenticated;
grant insert, update, delete on table public.markets to authenticated;

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

-- 只顯示「賣場與品項都已上架」的商品。
drop policy if exists "public reads active products" on public.products;
create policy "public reads active products"
on public.products for select to anon, authenticated
using (
  is_active = true and exists (
    select 1 from public.markets as m
    where m.id = products.market_id and m.is_active = true
  )
);

select m.name as market_name, count(p.id) as item_count
from public.markets as m
left join public.products as p on p.market_id = m.id
group by m.id, m.name
order by m.sort_order, m.created_at;
