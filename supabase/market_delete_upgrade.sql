-- NewShop：管理員刪除賣場與所屬商品
-- 在 Supabase SQL Editor 執行一次；既有訂單與訂單品項文字會保留。

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

select 'NewShop market delete upgrade complete' as result;

