import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const {PGlite}=createRequire(import.meta.url)('@electric-sql/pglite');
const db=new PGlite();
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
try {
  await db.exec(`create role anon;create role authenticated;create schema auth;
    create table auth.users(id uuid primary key);insert into auth.users values('${id(99)}');
    create function auth.uid() returns uuid language sql as $$select '${id(99)}'::uuid$$;
    create function public.is_admin() returns boolean language sql as $$select coalesce(current_setting('test.admin',true),'true')::boolean$$;
    create table public.orders(id uuid primary key,order_number text,recipient_name text,phone text,deposit_amount numeric,deposit_deduction numeric,total_amount numeric);
    create table public.order_deposit_refunds(id uuid default gen_random_uuid(),order_id uuid,amount numeric check(amount>0));
    insert into public.orders values
      ('${id(1)}','FULL','Test','0900',500,500,0),
      ('${id(2)}','PARTIAL','Test','0900',500,400,100),
      ('${id(3)}','OTHER','Other','0800',800,800,0),
      ('${id(4)}','MIXED','Test','0900',500,200,0),
      ('${id(5)}','NEGATIVE','Test','0900',500,600,0);
    insert into public.order_deposit_refunds(order_id,amount) values('${id(4)}',300);`);
  const sql=await readFile(new URL('../supabase/order_deposit_zero_refund_upgrade.sql',import.meta.url),'utf8');
  await db.exec(sql);await db.exec(sql);
  const call=(ids,amount=0)=>db.query('select public.admin_refund_zero_order_deposits($1::uuid[],$2,$3::date,$4,$5)',[ids,amount,'2026-10-15','Full redemption',null]);
  const before=(await db.query('select * from public.orders order by id')).rows;
  await assert.rejects(call([id(1)],1),/INVALID_ZERO_REFUND/);
  await assert.rejects(call([id(1)],-1),/INVALID_ZERO_REFUND/);
  await assert.rejects(call([]),/INVALID_ZERO_REFUND/);
  await assert.rejects(call([id(1),id(1)]),/INVALID_ZERO_REFUND/);
  await assert.rejects(call([id(70)]),/ORDER_NOT_FOUND/);
  await assert.rejects(call([id(1),id(2)]),/ZERO_REFUND_BALANCE_CHANGED/);
  assert.equal((await db.query('select count(*)::int as n from public.order_deposit_zero_refunds')).rows[0].n,0,'Invalid batch rolls back every zero record');
  await assert.rejects(call([id(5)]),/ZERO_REFUND_BALANCE_CHANGED/);
  await assert.rejects(call([id(1),id(3)]),/ZERO_REFUND_RECIPIENT_MISMATCH/);
  await call([id(1)]);await call([id(1)]);
  assert.equal((await db.query('select count(*)::int as n from public.order_deposit_zero_refunds')).rows[0].n,1,'Repeated clicks are idempotent');
  await call([id(3)]);await call([id(4)]);
  const rows=(await db.query('select amount,original_deposit,deposit_deduction,previous_refunds from public.order_deposit_zero_refunds order by order_id')).rows;
  assert.ok(rows.every(r=>Number(r.amount)===0));
  assert.deepEqual(rows.map(r=>Number(r.previous_refunds)),[0,0,300]);
  assert.deepEqual((await db.query('select * from public.orders order by id')).rows,before,'Zero refund changes no order amounts or deductions');
  assert.equal((await db.query('select count(*)::int as n from public.order_deposit_refunds')).rows[0].n,1,'Positive refund ledger remains untouched');
  await db.exec("select set_config('test.admin','false',false)");
  await assert.rejects(call([id(1)]),/ADMIN_REQUIRED/);
  assert.equal((await db.query("select has_table_privilege('authenticated','public.order_deposit_zero_refunds','insert') as allowed")).rows[0].allowed,false);
  console.log('PASS database: zero-only validation, balance checks, atomic batches, recipient grouping, idempotency, immutable money, permissions');
}finally{await db.close();}
