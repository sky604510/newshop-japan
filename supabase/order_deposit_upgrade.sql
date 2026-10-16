-- NewShop：訂單訂金（台幣整數元）。
-- 先執行 optional_contact_upgrade.sql、order_recipient_upgrade.sql。
-- 既有訂單預設沒有訂金，不影響訂單總額。
begin;
alter table public.orders add column if not exists deposit_amount numeric not null default 0
  check (deposit_amount >= 0 and deposit_amount = trunc(deposit_amount));
alter table public.orders alter column deposit_amount type numeric;

create table if not exists public.order_deposit_refunds (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null,
  order_id uuid not null,
  order_number text not null,
  recipient_name text not null,
  phone text not null default '',
  amount numeric not null check (amount > 0 and amount = trunc(amount)),
  refund_date date not null,
  refund_source text not null check (length(trim(refund_source)) > 0),
  refund_account text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);
create index if not exists order_deposit_refunds_order_id_idx on public.order_deposit_refunds(order_id);
alter table public.order_deposit_refunds enable row level security;
revoke all on public.order_deposit_refunds from anon, authenticated;
grant select on public.order_deposit_refunds to authenticated;
drop policy if exists "admins read deposit refunds" on public.order_deposit_refunds;
create policy "admins read deposit refunds" on public.order_deposit_refunds
  for select to authenticated using ((select public.is_admin()));

create or replace function public.set_order_deposit(p_order_id uuid, p_deposit_amount numeric)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  perform 1 from public.orders where id = p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if p_deposit_amount is null or p_deposit_amount::text in ('NaN','Infinity','-Infinity')
    or p_deposit_amount < 0 or p_deposit_amount <> trunc(p_deposit_amount) then
    raise exception 'INVALID_DEPOSIT_AMOUNT';
  end if;
  if p_deposit_amount < (select coalesce(sum(amount),0) from public.order_deposit_refunds where order_id = p_order_id) then
    raise exception 'DEPOSIT_BELOW_REFUNDED';
  end if;
  update public.orders set deposit_amount = p_deposit_amount, updated_at = now() where id = p_order_id;
end;
$$;
revoke all on function public.set_order_deposit(uuid,numeric) from public, anon, authenticated;

create or replace function public.place_order_with_deposit(
  p_recipient_name text, p_phone text, p_delivery_method text, p_note text, p_items jsonb, p_deposit_amount numeric
)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare order_id uuid;
begin
  order_id := public.place_order(p_recipient_name,p_phone,p_delivery_method,p_note,p_items);
  perform public.set_order_deposit(order_id,p_deposit_amount);
  return order_id;
end;
$$;
create or replace function public.admin_place_order_with_deposit(
  p_customer_id uuid, p_recipient_name text, p_phone text, p_delivery_method text, p_note text, p_items jsonb, p_deposit_amount numeric
)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare order_id uuid;
begin
  order_id := public.admin_place_order(p_customer_id,p_recipient_name,p_phone,p_delivery_method,p_note,p_items);
  perform public.set_order_deposit(order_id,p_deposit_amount);
  return order_id;
end;
$$;
create or replace function public.admin_save_order_with_deposit(
  p_order_id uuid, p_items jsonb, p_delivery_method text, p_recipient_name text, p_phone text, p_deposit_amount numeric
)
returns uuid language plpgsql security definer set search_path = ''
as $$
begin
  perform public.admin_save_order_with_recipient(p_order_id,p_items,p_delivery_method,p_recipient_name,p_phone);
  perform public.set_order_deposit(p_order_id,p_deposit_amount);
  return p_order_id;
end;
$$;
create or replace function public.admin_refund_order_deposits(
  p_order_ids uuid[], p_amount numeric, p_refund_date date, p_refund_source text, p_refund_account text
)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  refund_batch uuid := gen_random_uuid();
  refund_left numeric := p_amount;
  item record;
  available numeric;
  part numeric;
  recipient text;
  contact text;
  found_orders integer := 0;
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if coalesce(cardinality(p_order_ids),0) = 0
    or (select count(distinct id) from unnest(p_order_ids) as requested(id)) <> cardinality(p_order_ids) then
    raise exception 'INVALID_REFUND_ORDERS';
  end if;
  if p_amount is null or p_amount::text in ('NaN','Infinity','-Infinity')
    or p_amount <= 0 or p_amount <> trunc(p_amount) then raise exception 'INVALID_REFUND_AMOUNT'; end if;
  if p_refund_date is null or trim(coalesce(p_refund_source,'')) = '' then raise exception 'INVALID_REFUND_DETAILS'; end if;
  for item in
    select id, order_number, recipient_name, phone, deposit_amount
    from public.orders where id = any(p_order_ids) order by id for update
  loop
    found_orders := found_orders + 1;
    if recipient is null then
      recipient := lower(trim(item.recipient_name));
      contact := regexp_replace(coalesce(item.phone,''),'[^0-9]','','g');
    elsif recipient <> lower(trim(item.recipient_name))
      or contact <> regexp_replace(coalesce(item.phone,''),'[^0-9]','','g') then
      raise exception 'REFUND_RECIPIENT_MISMATCH';
    end if;
    available := item.deposit_amount - (select coalesce(sum(amount),0) from public.order_deposit_refunds where order_id = item.id);
    part := least(refund_left,available);
    if part > 0 then
      insert into public.order_deposit_refunds(batch_id,order_id,order_number,recipient_name,phone,amount,refund_date,refund_source,refund_account,created_by)
      values (refund_batch,item.id,item.order_number,item.recipient_name,coalesce(item.phone,''),part,p_refund_date,trim(p_refund_source),nullif(trim(coalesce(p_refund_account,'')),''),auth.uid());
      refund_left := refund_left - part;
    end if;
  end loop;
  if found_orders <> cardinality(p_order_ids) then raise exception 'INVALID_REFUND_ORDERS'; end if;
  if refund_left > 0 then raise exception 'REFUND_EXCEEDS_DEPOSIT'; end if;
  return refund_batch;
end;
$$;
revoke all on function public.admin_refund_order_deposits(uuid[],numeric,date,text,text) from public;
grant execute on function public.admin_refund_order_deposits(uuid[],numeric,date,text,text) to authenticated;
revoke all on function public.place_order_with_deposit(text,text,text,text,jsonb,numeric) from public;
revoke all on function public.admin_place_order_with_deposit(uuid,text,text,text,text,jsonb,numeric) from public;
revoke all on function public.admin_save_order_with_deposit(uuid,jsonb,text,text,text,numeric) from public;
grant execute on function public.place_order_with_deposit(text,text,text,text,jsonb,numeric) to authenticated;
grant execute on function public.admin_place_order_with_deposit(uuid,text,text,text,text,jsonb,numeric) to authenticated;
grant execute on function public.admin_save_order_with_deposit(uuid,jsonb,text,text,text,numeric) to authenticated;
commit;
select 'NewShop order deposit upgrade complete' as result;
