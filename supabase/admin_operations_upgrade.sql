-- NewShop：帳號快照、外幣成本、匯率、訂單數量／刪除、採購歷史
-- 可重複執行，不會刪除既有訂單。

alter table public.orders
add column if not exists account_email text;

update public.orders as o
set account_email = coalesce(
  (select c.email from public.customers as c where c.id = o.customer_id),
  (select u.email from auth.users as u where u.id = o.user_id)
)
where o.account_email is null;

create or replace function public.snapshot_order_account()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.account_email is null then
    select coalesce(c.email, u.email) into new.account_email
    from auth.users as u
    left join public.customers as c on c.id = new.customer_id
    where u.id = new.user_id;
  end if;
  return new;
end;
$$;

drop trigger if exists orders_snapshot_account on public.orders;
create trigger orders_snapshot_account
before insert on public.orders
for each row execute function public.snapshot_order_account();

alter table public.product_costs
add column if not exists foreign_cost numeric(12, 4) not null default 0 check (foreign_cost >= 0);

alter table public.product_costs
add column if not exists exchange_rate numeric(12, 6) not null default 0 check (exchange_rate >= 0);

create table if not exists public.procurement_checks (
  product_id uuid primary key references public.products(id) on delete cascade,
  is_purchased boolean not null default false,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.procurement_checks enable row level security;
revoke all on table public.procurement_checks from anon, authenticated;
grant select, insert, update, delete on table public.procurement_checks to authenticated;

drop policy if exists "admins read procurement checks" on public.procurement_checks;
create policy "admins read procurement checks" on public.procurement_checks
for select to authenticated using ((select public.is_admin()));

drop policy if exists "admins insert procurement checks" on public.procurement_checks;
create policy "admins insert procurement checks" on public.procurement_checks
for insert to authenticated with check ((select public.is_admin()));

drop policy if exists "admins update procurement checks" on public.procurement_checks;
create policy "admins update procurement checks" on public.procurement_checks
for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

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
    update public.order_items set unit_cost = final_cost
    where product_id = p_product_id and unit_cost = 0;
  end if;
  return final_cost;
end;
$$;

revoke all on function public.admin_set_product_costs(uuid, numeric, numeric, numeric, boolean) from public;
grant execute on function public.admin_set_product_costs(uuid, numeric, numeric, numeric, boolean) to authenticated;

create or replace function public.admin_update_order_item_quantity(
  p_order_item_id uuid,
  p_quantity integer
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_item public.order_items%rowtype;
  stock_available integer;
  quantity_delta integer;
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if p_quantity is null or p_quantity < 0 then raise exception 'INVALID_QUANTITY'; end if;

  select * into target_item from public.order_items where id = p_order_item_id for update;
  if not found then raise exception 'ORDER_ITEM_NOT_FOUND'; end if;
  quantity_delta := p_quantity - target_item.quantity;

  if target_item.product_id is not null and quantity_delta <> 0 then
    select stock into stock_available from public.products where id = target_item.product_id for update;
    if quantity_delta > 0 and stock_available < quantity_delta then raise exception 'INSUFFICIENT_STOCK'; end if;
    update public.products set stock = stock - quantity_delta where id = target_item.product_id;
  end if;

  if p_quantity = 0 then
    delete from public.order_items where id = p_order_item_id;
  else
    update public.order_items set quantity = p_quantity where id = p_order_item_id;
  end if;
  update public.orders set total_amount = (
    select coalesce(sum(subtotal), 0) from public.order_items where order_id = target_item.order_id
  ) where id = target_item.order_id;
  return target_item.order_id;
end;
$$;

revoke all on function public.admin_update_order_item_quantity(uuid, integer) from public;
grant execute on function public.admin_update_order_item_quantity(uuid, integer) to authenticated;

create or replace function public.admin_delete_order(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  item record;
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  perform 1 from public.orders where id = p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;

  for item in select product_id, quantity from public.order_items where order_id = p_order_id for update
  loop
    if item.product_id is not null then
      update public.products set stock = stock + item.quantity where id = item.product_id;
    end if;
  end loop;
  delete from public.orders where id = p_order_id;
end;
$$;

revoke all on function public.admin_delete_order(uuid) from public;
grant execute on function public.admin_delete_order(uuid) to authenticated;

create or replace function public.admin_delete_market(p_market_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;

  perform 1 from public.markets where id = p_market_id for update;
  if not found then raise exception 'MARKET_NOT_FOUND'; end if;

  delete from public.products where market_id = p_market_id;
  delete from public.markets where id = p_market_id;
end;
$$;

revoke all on function public.admin_delete_market(uuid) from public;
grant execute on function public.admin_delete_market(uuid) to authenticated;

select 'NewShop admin operations upgrade complete' as result;
