-- NewShop：阻止同一賣場新增或改名成重複商品名稱。
-- 在 Supabase SQL Editor 執行一次；不會修改或刪除既有商品、訂單。
-- 既有同名商品可編輯其他欄位，但應在後台逐一更名後再儲存賣場。

create or replace function public.prevent_duplicate_market_product_name()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
    and new.market_id = old.market_id
    and pg_catalog.lower(pg_catalog.btrim(new.name)) = pg_catalog.lower(pg_catalog.btrim(old.name)) then
    return new;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.market_id::text, 0));
  if exists (
    select 1 from public.products as product
    where product.market_id = new.market_id
      and product.id <> new.id
      and pg_catalog.lower(pg_catalog.btrim(product.name)) = pg_catalog.lower(pg_catalog.btrim(new.name))
  ) then
    raise exception 'DUPLICATE_PRODUCT_NAME' using errcode = '23505';
  end if;
  return new;
end;
$$;

drop trigger if exists prevent_duplicate_market_product_name on public.products;
create trigger prevent_duplicate_market_product_name
before insert or update of market_id, name on public.products
for each row execute function public.prevent_duplicate_market_product_name();

select 'NewShop product name uniqueness upgrade complete' as result;
