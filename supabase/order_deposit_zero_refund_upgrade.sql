-- Supabase SQL Editor：登記已全額折抵訂金的 0 元退款。
-- 前置條件：既有訂金與折抵功能已啟用。
-- 不更動既有正數退款規則，不取消折抵，也不改變訂單應收金額。
begin;
create table if not exists public.order_deposit_zero_refunds (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null,
  order_id uuid references public.orders(id) on delete set null,
  order_number text not null,
  recipient_name text not null,
  phone text not null default '',
  amount numeric not null default 0 check (amount = 0),
  original_deposit numeric not null check (original_deposit > 0),
  deposit_deduction numeric not null check (deposit_deduction >= 0),
  previous_refunds numeric not null check (previous_refunds >= 0),
  refund_date date not null,
  refund_source text not null check (length(trim(refund_source)) > 0),
  refund_account text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (order_id, original_deposit, deposit_deduction, previous_refunds)
);
alter table public.order_deposit_zero_refunds enable row level security;
revoke all on public.order_deposit_zero_refunds from anon, authenticated;
grant select on public.order_deposit_zero_refunds to authenticated;
drop policy if exists "admins read zero deposit refunds" on public.order_deposit_zero_refunds;
create policy "admins read zero deposit refunds" on public.order_deposit_zero_refunds
for select to authenticated using ((select public.is_admin()));

create or replace function public.admin_refund_zero_order_deposits(
  p_order_ids uuid[], p_amount numeric, p_refund_date date,
  p_refund_source text, p_refund_account text default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  entry public.orders%rowtype;
  batch uuid := gen_random_uuid();
  refunded numeric;
  first_recipient text;
  first_phone text;
  recipient text;
  phone_key text;
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if p_amount is distinct from 0::numeric or p_refund_date is null or coalesce(trim(p_refund_source),'') = ''
    or coalesce(cardinality(p_order_ids),0) = 0 then raise exception 'INVALID_ZERO_REFUND'; end if;
  if cardinality(p_order_ids) <> (select count(distinct id) from unnest(p_order_ids) as requested(id))
    then raise exception 'INVALID_ZERO_REFUND'; end if;
  perform id from public.orders where id = any(p_order_ids) order by id for update;
  if (select count(*) from public.orders where id = any(p_order_ids)) <> cardinality(p_order_ids)
    then raise exception 'ORDER_NOT_FOUND'; end if;
  for entry in select * from public.orders where id = any(p_order_ids) order by id loop
    recipient := lower(trim(entry.recipient_name));
    phone_key := regexp_replace(coalesce(entry.phone,''), '\D', '', 'g');
    if first_recipient is null then first_recipient := recipient; first_phone := phone_key;
    elsif recipient is distinct from first_recipient or phone_key is distinct from first_phone
      then raise exception 'ZERO_REFUND_RECIPIENT_MISMATCH'; end if;
    select coalesce(sum(amount),0) into refunded from public.order_deposit_refunds where order_id = entry.id;
    if coalesce(entry.deposit_amount,0) <= 0 or entry.deposit_amount - coalesce(entry.deposit_deduction,0) - refunded <> 0
      then raise exception 'ZERO_REFUND_BALANCE_CHANGED'; end if;
    insert into public.order_deposit_zero_refunds (
      batch_id,order_id,order_number,recipient_name,phone,amount,
      original_deposit,deposit_deduction,previous_refunds,
      refund_date,refund_source,refund_account,created_by
    ) values (
      batch,entry.id,entry.order_number,entry.recipient_name,coalesce(entry.phone,''),0,
      entry.deposit_amount,coalesce(entry.deposit_deduction,0),refunded,
      p_refund_date,trim(p_refund_source),nullif(trim(p_refund_account),''),auth.uid()
    ) on conflict (order_id,original_deposit,deposit_deduction,previous_refunds) do nothing;
  end loop;
  return batch;
end $$;
revoke all on function public.admin_refund_zero_order_deposits(uuid[],numeric,date,text,text) from public, anon;
grant execute on function public.admin_refund_zero_order_deposits(uuid[],numeric,date,text,text) to authenticated;
notify pgrst, 'reload schema';
commit;
