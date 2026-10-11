-- 在 Supabase SQL Editor 完整執行。保留原圖與現有賣場資料。
begin;
alter table public.markets add column if not exists cover_layout jsonb;
alter table public.markets drop constraint if exists markets_cover_layout_valid;
alter table public.markets add constraint markets_cover_layout_valid check (
  cover_layout is null or (
    jsonb_typeof(cover_layout) = 'object'
    and jsonb_typeof(cover_layout->'zoom') = 'number'
    and jsonb_typeof(cover_layout->'y') = 'number'
    and coalesce((cover_layout->>'zoom')::numeric between 1 and 3, false)
    and coalesce((cover_layout->>'y')::numeric between 0 and 100, false)
  )
);
notify pgrst, 'reload schema';
commit;
