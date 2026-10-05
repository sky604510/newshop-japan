-- NewShop 最高所有者與商品圖片功能升級
-- 請在 Supabase SQL Editor 執行一次；可安全重複執行。

alter table public.profiles
drop constraint if exists profiles_role_check;

alter table public.profiles
add constraint profiles_role_check
check (role in ('customer', 'admin', 'owner'));

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested_username text;
  requested_role text := 'customer';
begin
  requested_username := lower(trim(coalesce(
    new.raw_user_meta_data ->> 'username',
    new.raw_user_meta_data ->> 'account',
    split_part(new.email, '@', 1)
  )));

  if requested_username is null or char_length(requested_username) < 2 then
    requested_username := 'user_' || substr(new.id::text, 1, 8);
  end if;

  requested_username := left(requested_username, 40);

  if exists (select 1 from public.profiles where username = requested_username) then
    requested_username := left(requested_username, 31) || '_' || substr(new.id::text, 1, 8);
  end if;

  if new.email_confirmed_at is not null
    and lower(trim(new.email)) in ('sky604510@gmail.com', 'kame2937@gmail.com') then
    requested_role := 'owner';
  end if;

  insert into public.profiles (id, username, display_name, role)
  values (
    new.id,
    requested_username,
    nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
    requested_role
  );
  return new;
end;
$$;

create or replace function public.sync_verified_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.email_confirmed_at is not null
    and lower(trim(new.email)) in ('sky604510@gmail.com', 'kame2937@gmail.com') then
    update public.profiles set role = 'owner' where id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_owner_verified on auth.users;
create trigger on_auth_owner_verified
after update of email_confirmed_at, email on auth.users
for each row execute function public.sync_verified_owner();

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles
    where id = (select auth.uid())
      and role in ('admin', 'owner')
  );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

insert into public.profiles (id, username, role)
select u.id, 'owner_' || substr(u.id::text, 1, 8), 'owner'
from auth.users as u
left join public.profiles as p on p.id = u.id
where p.id is null
  and u.email_confirmed_at is not null
  and lower(u.email) in ('sky604510@gmail.com', 'kame2937@gmail.com')
on conflict (id) do nothing;

update public.profiles as p
set role = 'owner'
from auth.users as u
where p.id = u.id
  and u.email_confirmed_at is not null
  and lower(u.email) in ('sky604510@gmail.com', 'kame2937@gmail.com');

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'product-images', 'product-images', true, 5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "managers upload product images" on storage.objects;
create policy "managers upload product images"
on storage.objects for insert to authenticated
with check (bucket_id = 'product-images' and (select public.is_admin()));

drop policy if exists "managers update product images" on storage.objects;
create policy "managers update product images"
on storage.objects for update to authenticated
using (bucket_id = 'product-images' and (select public.is_admin()))
with check (bucket_id = 'product-images' and (select public.is_admin()));

drop policy if exists "managers delete product images" on storage.objects;
create policy "managers delete product images"
on storage.objects for delete to authenticated
using (bucket_id = 'product-images' and (select public.is_admin()));

select u.email, p.role
from public.profiles as p
join auth.users as u on u.id = p.id
where lower(u.email) in ('sky604510@gmail.com', 'kame2937@gmail.com');
