-- NewShop：商品改名時，同步更新已下單品項的顯示名稱。
-- 在 Supabase SQL Editor 執行一次；只變更仍連結同一商品 ID 的訂單品名。
-- 不修改訂單金額、數量、成本或發貨狀態。

create or replace function public.sync_order_item_product_name()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.order_items
  set product_name = new.name
  where product_id = new.id
    and product_name is distinct from new.name;
  return new;
end;
$$;

drop trigger if exists sync_order_item_product_name on public.products;
create trigger sync_order_item_product_name
after update of name on public.products
for each row
when (old.name is distinct from new.name)
execute function public.sync_order_item_product_name();

-- 補齊過去已改名、但訂單仍保留舊名稱的品項。
update public.order_items as item
set product_name = product.name
from public.products as product
where item.product_id = product.id
  and item.product_name is distinct from product.name;

select 'NewShop product name order sync upgrade complete' as result;
