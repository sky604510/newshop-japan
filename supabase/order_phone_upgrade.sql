-- NewShop：編輯訂單時一併儲存聯絡電話，保留原有訂單／品項／庫存交易邏輯。
-- 先執行 order_cost_override_upgrade.sql，再於 Supabase SQL Editor 執行本檔。
-- 電話可留白；不會變更會員帳號、Email 或客戶主檔。

create or replace function public.admin_save_order_with_phone(
  p_order_id uuid,
  p_items jsonb,
  p_delivery_method text,
  p_phone text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;

  perform public.admin_save_order_items(p_order_id, p_items, p_delivery_method);
  update public.orders
  set phone = pg_catalog.btrim(coalesce(p_phone, '')),
      updated_at = now()
  where id = p_order_id;

  return p_order_id;
end;
$$;

revoke all on function public.admin_save_order_with_phone(uuid, jsonb, text, text) from public;
grant execute on function public.admin_save_order_with_phone(uuid, jsonb, text, text) to authenticated;

select 'NewShop order phone upgrade complete' as result;
