-- NewShop：賣場置頂、賣場排序與品項排序
-- 在 Supabase SQL Editor 執行一次；不會刪除或重建任何資料。

alter table public.markets
add column if not exists is_pinned boolean not null default false;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'products' and column_name = 'sort_order'
  ) then
    alter table public.products add column sort_order integer not null default 0;

    with ranked as (
      select id, (row_number() over (partition by market_id order by created_at, id) - 1)::integer as position
      from public.products
    )
    update public.products as product
    set sort_order = ranked.position
    from ranked
    where product.id = ranked.id;
  end if;
end;
$$;

create index if not exists markets_display_order_idx
on public.markets(is_pinned desc, sort_order, created_at desc);

create index if not exists products_market_sort_idx
on public.products(market_id, sort_order, created_at);

select 'NewShop sorting upgrade complete' as result;
