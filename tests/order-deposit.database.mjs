import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const { PGlite } = createRequire(import.meta.url)('@electric-sql/pglite');
const db = new PGlite();
try {
  await db.exec(`
    create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key);
    insert into auth.users values ('11111111-1111-4111-8111-111111111111');
    create function auth.uid() returns uuid language sql as $$ select '11111111-1111-4111-8111-111111111111'::uuid $$;
    create function public.is_admin() returns boolean language sql as $$ select coalesce(current_setting('test.admin', true), 'true')::boolean $$;
    create table public.orders (
      id uuid primary key default gen_random_uuid(), order_number text not null default gen_random_uuid()::text,
      recipient_name text not null, phone text default '', total_amount numeric not null default 100,
      updated_at timestamptz default now()
    );
    create function public.place_order(text,text,text,text,jsonb) returns uuid language plpgsql as $$
    declare result uuid;
    begin
      insert into public.orders(recipient_name,phone,total_amount) values ($1,$2,($5->0->>'price')::numeric) returning id into result;
      return result;
    end; $$;
    create function public.admin_place_order(uuid,text,text,text,text,jsonb) returns uuid language plpgsql as $$
    begin
      if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
      return public.place_order($2,$3,$4,$5,$6);
    end; $$;
    create function public.admin_save_order_with_recipient(uuid,jsonb,text,text,text) returns uuid language plpgsql as $$
    begin
      if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
      update public.orders set recipient_name=$4,phone=$5,total_amount=($2->0->>'price')::numeric where id=$1;
      return $1;
    end; $$;
  `);
  const migration = await readFile(new URL('../supabase/order_deposit_upgrade.sql', import.meta.url), 'utf8');
  await db.exec(migration); await db.exec(migration);
  const place = (price, deposit) => db.query('select public.place_order_with_deposit($1,$2,$3,$4,$5::jsonb,$6) as id', ['測試人','0900','面交取貨','',JSON.stringify([{ price }]),deposit]);
  const a = (await place(100,1000)).rows[0].id;
  const b = (await db.query('select public.admin_place_order_with_deposit(null,$1,$2,$3,$4,$5::jsonb,$6) as id', ['測試人','0900','面交取貨','',JSON.stringify([{ price: 200 }]),200])).rows[0].id;
  assert.equal(Number((await db.query('select total_amount,deposit_amount from public.orders where id=$1',[a])).rows[0].deposit_amount),1000);
  for (const amount of [-1,1.5,null]) await assert.rejects(place(100,amount), /INVALID_DEPOSIT_AMOUNT/);
  assert.equal((await db.query('select count(*)::int as n from public.orders')).rows[0].n,2);
  const refund = (ids, amount) => db.query('select public.admin_refund_order_deposits($1::uuid[],$2,$3::date,$4,$5) as batch', [ids,amount,'2026-09-30','我','銀行尾號1234']);
  const batch = (await refund([a,b],1100)).rows[0].batch;
  const rows = (await db.query('select order_id,amount,recipient_name,refund_date,refund_source,refund_account from public.order_deposit_refunds where batch_id=$1 order by order_id',[batch])).rows;
  assert.equal(rows.length,2);
  assert.equal(rows.reduce((sum,row)=>sum+Number(row.amount),0),1100);
  assert.ok(rows.every(row=>row.refund_source==='我' && row.refund_account==='銀行尾號1234'));
  await assert.rejects(refund([a,b],201), /REFUND_EXCEEDS_DEPOSIT/);
  assert.equal((await db.query('select count(*)::int as n from public.order_deposit_refunds')).rows[0].n,2);
  await assert.rejects(db.query('select public.admin_save_order_with_deposit($1,$2::jsonb,$3,$4,$5,$6)',[a,JSON.stringify([{price:50}]),'面交取貨','改名','0900',100]),/DEPOSIT_BELOW_REFUNDED/);
  assert.equal((await db.query('select recipient_name,total_amount from public.orders where id=$1',[a])).rows[0].recipient_name,'測試人');
  await db.query('select public.admin_save_order_with_deposit($1,$2::jsonb,$3,$4,$5,$6)',[a,JSON.stringify([{price:50}]),'面交取貨','新名字','0900',1000]);
  assert.equal(Number((await db.query('select total_amount,deposit_amount from public.orders where id=$1',[a])).rows[0].deposit_amount),1000);
  await db.exec("select set_config('test.admin','false',false)");
  await assert.rejects(refund([b],1),/ADMIN_REQUIRED/);
  console.log('PASS PostgreSQL: unlimited note amount, checkout rollback, multi-order refund, over-refund rollback, edit protection, admin gate');
} finally { await db.close(); }
