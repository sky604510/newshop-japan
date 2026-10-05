-- NewShop：編輯訂單時同步儲存收件人與聯絡電話。
-- 先執行 order_cost_override_upgrade.sql，再於 Supabase SQL Editor 執行本檔。
-- 收件人必填、電話可留白；既有訂單品項與聯絡資料在同一交易中更新。
-- 只修改這筆訂單，不更動會員帳號、Email 或客戶主檔。

create or replace function public.admin_save_order_with_recipient(
  p_order_id uuid,
  p_items jsonb,
  p_delivery_method text,
  p_recipient_name text,
  p_phone text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if pg_catalog.btrim(coalesce(p_recipient_name, '')) = '' then raise exception 'RECIPIENT_REQUIRED'; end if;

  perform public.admin_save_order_items(p_order_id, p_items, p_delivery_method);
  update public.orders
  set recipient_name = pg_catalog.btrim(p_recipient_name),
      phone = pg_catalog.btrim(coalesce(p_phone, '')),
      updated_at = now()
  where id = p_order_id;

  return p_order_id;
end;
$$;

revoke all on function public.admin_save_order_with_recipient(uuid, jsonb, text, text, text) from public;
grant execute on function public.admin_save_order_with_recipient(uuid, jsonb, text, text, text) to authenticated;

select 'NewShop order recipient upgrade complete' as result;
