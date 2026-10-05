-- NewShop：訂單單品採購確認、發貨狀態與發貨日期。
-- 可重複執行，不會修改或刪除既有訂單。

create table if not exists public.order_item_fulfillments (
  order_item_id uuid primary key references public.order_items(id) on delete cascade,
  purchase_confirmed boolean not null default false,
  shipped_at date,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

create index if not exists order_item_fulfillments_shipped_at_idx
on public.order_item_fulfillments(shipped_at);

alter table public.order_item_fulfillments enable row level security;
revoke all on table public.order_item_fulfillments from anon, authenticated;
grant select, insert, update on table public.order_item_fulfillments to authenticated;

drop policy if exists "admins read fulfillment records" on public.order_item_fulfillments;
create policy "admins read fulfillment records"
on public.order_item_fulfillments for select to authenticated
using ((select public.is_admin()));

drop policy if exists "admins insert fulfillment records" on public.order_item_fulfillments;
create policy "admins insert fulfillment records"
on public.order_item_fulfillments for insert to authenticated
with check ((select public.is_admin()));

drop policy if exists "admins update fulfillment records" on public.order_item_fulfillments;
create policy "admins update fulfillment records"
on public.order_item_fulfillments for update to authenticated
using ((select public.is_admin()))
with check ((select public.is_admin()));

create or replace function public.admin_set_order_item_purchase(
  p_order_item_id uuid,
  p_confirmed boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if not exists (select 1 from public.order_items where id = p_order_item_id) then
    raise exception 'ORDER_ITEM_NOT_FOUND';
  end if;

  insert into public.order_item_fulfillments (order_item_id, purchase_confirmed, updated_by, updated_at)
  values (p_order_item_id, coalesce(p_confirmed, false), auth.uid(), now())
  on conflict (order_item_id) do update set
    purchase_confirmed = excluded.purchase_confirmed,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at;
end;
$$;

create or replace function public.admin_ship_order_items(
  p_order_item_ids uuid[],
  p_shipped_at date default current_date
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected integer;
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if coalesce(array_length(p_order_item_ids, 1), 0) = 0 then raise exception 'NO_ITEMS_SELECTED'; end if;
  if exists (
    select 1 from unnest(p_order_item_ids) as requested(id)
    where not exists (select 1 from public.order_items as oi where oi.id = requested.id)
  ) then raise exception 'ORDER_ITEM_NOT_FOUND'; end if;

  insert into public.order_item_fulfillments (order_item_id, shipped_at, updated_by, updated_at)
  select distinct id, coalesce(p_shipped_at, current_date), auth.uid(), now()
  from unnest(p_order_item_ids) as requested(id)
  on conflict (order_item_id) do update set
    shipped_at = excluded.shipped_at,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at;

  get diagnostics affected = row_count;
  return affected;
end;
$$;

create or replace function public.admin_set_order_item_shipped_date(
  p_order_item_id uuid,
  p_shipped_at date
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if p_shipped_at is null then raise exception 'SHIP_DATE_REQUIRED'; end if;
  if not exists (select 1 from public.order_items where id = p_order_item_id) then
    raise exception 'ORDER_ITEM_NOT_FOUND';
  end if;

  insert into public.order_item_fulfillments (order_item_id, shipped_at, updated_by, updated_at)
  values (p_order_item_id, p_shipped_at, auth.uid(), now())
  on conflict (order_item_id) do update set
    shipped_at = excluded.shipped_at,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at;
end;
$$;

create or replace function public.admin_restore_order_item(p_order_item_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if not exists (select 1 from public.order_items where id = p_order_item_id) then
    raise exception 'ORDER_ITEM_NOT_FOUND';
  end if;

  update public.order_item_fulfillments
  set shipped_at = null, updated_by = auth.uid(), updated_at = now()
  where order_item_id = p_order_item_id;
end;
$$;

create or replace function public.admin_update_order_note(
  p_order_id uuid,
  p_note text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  update public.orders
  set note = trim(coalesce(p_note, '')), updated_at = now()
  where id = p_order_id;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
end;
$$;

revoke all on function public.admin_set_order_item_purchase(uuid, boolean) from public;
revoke all on function public.admin_ship_order_items(uuid[], date) from public;
revoke all on function public.admin_set_order_item_shipped_date(uuid, date) from public;
revoke all on function public.admin_restore_order_item(uuid) from public;
revoke all on function public.admin_update_order_note(uuid, text) from public;
grant execute on function public.admin_set_order_item_purchase(uuid, boolean) to authenticated;
grant execute on function public.admin_ship_order_items(uuid[], date) to authenticated;
grant execute on function public.admin_set_order_item_shipped_date(uuid, date) to authenticated;
grant execute on function public.admin_restore_order_item(uuid) to authenticated;
grant execute on function public.admin_update_order_note(uuid, text) to authenticated;

select 'NewShop fulfillment upgrade complete' as result;
