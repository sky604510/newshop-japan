-- NewShop：商品成本與訂單成本快照
-- 成本獨立保存，只有管理員可讀取；可重複執行且不刪除既有資料。

create table if not exists public.product_costs (
  product_id uuid primary key references public.products(id) on delete cascade,
  cost numeric(12, 2) not null default 0 check (cost >= 0),
  updated_at timestamptz not null default now()
);

alter table public.order_items
add column if not exists unit_cost numeric(12, 2) not null default 0
check (unit_cost >= 0);

drop trigger if exists product_costs_set_updated_at on public.product_costs;
create trigger product_costs_set_updated_at
before update on public.product_costs
for each row execute function public.set_updated_at();

alter table public.product_costs enable row level security;
revoke all on table public.product_costs from anon, authenticated;
grant select, insert, update, delete on table public.product_costs to authenticated;

drop policy if exists "admins read product costs" on public.product_costs;
create policy "admins read product costs"
on public.product_costs for select to authenticated
using ((select public.is_admin()));

drop policy if exists "admins insert product costs" on public.product_costs;
create policy "admins insert product costs"
on public.product_costs for insert to authenticated
with check ((select public.is_admin()));

drop policy if exists "admins update product costs" on public.product_costs;
create policy "admins update product costs"
on public.product_costs for update to authenticated
using ((select public.is_admin()))
with check ((select public.is_admin()));

drop policy if exists "admins delete product costs" on public.product_costs;
create policy "admins delete product costs"
on public.product_costs for delete to authenticated
using ((select public.is_admin()));

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
    update public.order_items
    set unit_cost = p_cost
    where product_id = p_product_id and unit_cost = 0;
  end if;
end;
$$;

revoke all on function public.admin_set_product_cost(uuid, numeric, boolean) from public;
grant execute on function public.admin_set_product_cost(uuid, numeric, boolean) to authenticated;

create or replace function public.snapshot_order_item_cost()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.product_id is not null then
    select pc.cost into new.unit_cost
    from public.product_costs as pc
    where pc.product_id = new.product_id;
  end if;
  new.unit_cost := coalesce(new.unit_cost, 0);
  return new;
end;
$$;

drop trigger if exists order_items_snapshot_cost on public.order_items;
create trigger order_items_snapshot_cost
before insert on public.order_items
for each row execute function public.snapshot_order_item_cost();

select 'NewShop secure product cost upgrade complete' as result;
