-- 訂金備註與商品內扣。先執行 order_deposit_upgrade.sql、order_split_upgrade.sql。
-- 舊訂單預設沒有備註或內扣；重複執行安全。
begin;
alter table public.orders add column if not exists deposit_note text not null default '';
alter table public.orders add column if not exists deposit_deduction numeric not null default 0
  check (deposit_deduction >= 0 and deposit_deduction = trunc(deposit_deduction));
alter table public.orders drop constraint if exists orders_deposit_deduction_within_deposit;
alter table public.orders add constraint orders_deposit_deduction_within_deposit
  check (deposit_deduction <= deposit_amount);

create or replace function public.check_refund_deposit_balance()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare available numeric;
begin
  select deposit_amount - deposit_deduction into available
    from public.orders where id = new.order_id for update;
  if not found or new.amount + (select coalesce(sum(amount),0) from public.order_deposit_refunds where order_id = new.order_id) > available then
    raise exception 'REFUND_EXCEEDS_DEPOSIT';
  end if;
  return new;
end;
$$;
drop trigger if exists check_refund_deposit_balance on public.order_deposit_refunds;
create trigger check_refund_deposit_balance before insert on public.order_deposit_refunds
  for each row execute function public.check_refund_deposit_balance();
revoke all on function public.check_refund_deposit_balance() from public, anon, authenticated;

create or replace function public.set_order_deposit_details(
  p_order_id uuid, p_deposit_amount numeric, p_deposit_note text, p_deduction_amount numeric
)
returns void language plpgsql security definer set search_path = ''
as $$
declare gross numeric;
begin
  perform 1 from public.orders where id = p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if p_deduction_amount is null or p_deduction_amount::text in ('NaN','Infinity','-Infinity')
    or p_deduction_amount < 0 or p_deduction_amount <> trunc(p_deduction_amount) then
    raise exception 'INVALID_DEPOSIT_DEDUCTION';
  end if;
  select coalesce(sum(unit_price * quantity),0) into gross
    from public.order_items where order_id = p_order_id;
  if p_deduction_amount > gross or p_deduction_amount > p_deposit_amount then
    raise exception 'DEDUCTION_EXCEEDS_PRODUCTS_OR_DEPOSIT';
  end if;
  if p_deposit_amount - p_deduction_amount <
    (select coalesce(sum(amount),0) from public.order_deposit_refunds where order_id = p_order_id) then
    raise exception 'DEPOSIT_BELOW_REFUNDED';
  end if;
  if p_deposit_amount = 0 and (p_deduction_amount > 0 or trim(coalesce(p_deposit_note,'')) <> '') then
    raise exception 'DEPOSIT_REQUIRED_FOR_DETAILS';
  end if;
  perform public.set_order_deposit(p_order_id,p_deposit_amount);
  update public.orders set deposit_note = trim(coalesce(p_deposit_note,'')),
    deposit_deduction = p_deduction_amount, total_amount = gross - p_deduction_amount,
    updated_at = now() where id = p_order_id;
end;
$$;
revoke all on function public.set_order_deposit_details(uuid,numeric,text,numeric) from public, anon, authenticated;

create or replace function public.place_order_with_deposit_details(
  p_recipient_name text, p_phone text, p_delivery_method text, p_note text, p_items jsonb,
  p_deposit_amount numeric, p_deposit_note text, p_deduction_amount numeric
)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare order_id uuid;
begin
  order_id := public.place_order(p_recipient_name,p_phone,p_delivery_method,p_note,p_items);
  perform public.set_order_deposit_details(order_id,p_deposit_amount,p_deposit_note,p_deduction_amount);
  return order_id;
end;
$$;
create or replace function public.admin_place_order_with_deposit_details(
  p_customer_id uuid, p_recipient_name text, p_phone text, p_delivery_method text, p_note text, p_items jsonb,
  p_deposit_amount numeric, p_deposit_note text, p_deduction_amount numeric
)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare order_id uuid;
begin
  order_id := public.admin_place_order(p_customer_id,p_recipient_name,p_phone,p_delivery_method,p_note,p_items);
  perform public.set_order_deposit_details(order_id,p_deposit_amount,p_deposit_note,p_deduction_amount);
  return order_id;
end;
$$;
create or replace function public.admin_save_order_with_deposit_details(
  p_order_id uuid, p_items jsonb, p_delivery_method text, p_recipient_name text, p_phone text,
  p_deposit_amount numeric, p_deposit_note text, p_deduction_amount numeric
)
returns uuid language plpgsql security definer set search_path = ''
as $$
begin
  perform public.admin_save_order_with_recipient(p_order_id,p_items,p_delivery_method,p_recipient_name,p_phone);
  perform public.set_order_deposit_details(p_order_id,p_deposit_amount,p_deposit_note,p_deduction_amount);
  return p_order_id;
end;
$$;
create or replace function public.admin_split_order_with_deposit_details(
  p_order_id uuid, p_order_item_ids uuid[]
)
returns text language plpgsql security definer set search_path = ''
as $$
declare old_deposit numeric; old_note text; old_deduction numeric; new_number text;
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  select deposit_amount, deposit_note, deposit_deduction into old_deposit, old_note, old_deduction
    from public.orders where id = p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  new_number := public.admin_split_order_items(p_order_id,p_order_item_ids);
  perform public.set_order_deposit_details(p_order_id,old_deposit,old_note,old_deduction);
  return new_number;
end;
$$;
revoke all on function public.place_order_with_deposit_details(text,text,text,text,jsonb,numeric,text,numeric) from public;
revoke all on function public.admin_place_order_with_deposit_details(uuid,text,text,text,text,jsonb,numeric,text,numeric) from public;
revoke all on function public.admin_save_order_with_deposit_details(uuid,jsonb,text,text,text,numeric,text,numeric) from public;
revoke all on function public.admin_split_order_with_deposit_details(uuid,uuid[]) from public;
grant execute on function public.place_order_with_deposit_details(text,text,text,text,jsonb,numeric,text,numeric) to authenticated;
grant execute on function public.admin_place_order_with_deposit_details(uuid,text,text,text,text,jsonb,numeric,text,numeric) to authenticated;
grant execute on function public.admin_save_order_with_deposit_details(uuid,jsonb,text,text,text,numeric,text,numeric) to authenticated;
grant execute on function public.admin_split_order_with_deposit_details(uuid,uuid[]) to authenticated;

-- 分批退款時，先扣掉已用於商品的訂金，再分配至各筆來源訂單。
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
    select id, order_number, recipient_name, phone, deposit_amount, deposit_deduction
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
    available := item.deposit_amount - item.deposit_deduction
      - (select coalesce(sum(amount),0) from public.order_deposit_refunds where order_id = item.id);
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
commit;
select 'NewShop deposit details upgrade complete' as result;
