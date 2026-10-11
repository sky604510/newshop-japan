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
      recipient_name text not null, phone text default '', total_amount numeric not null default 0,
      updated_at timestamptz default now()
    );
    create table public.order_items (
      id uuid primary key default gen_random_uuid(), order_id uuid not null references public.orders(id),
      unit_price numeric not null, quantity integer not null
    );
    create function public.place_order(text,text,text,text,jsonb) returns uuid language plpgsql as $$
    declare result uuid; entry record;
    begin
      insert into public.orders(recipient_name,phone) values ($1,$2) returning id into result;
      for entry in select price, quantity from jsonb_to_recordset($5) as x(price numeric,quantity integer) loop
        insert into public.order_items(order_id,unit_price,quantity) values (result,entry.price,entry.quantity);
      end loop;
      update public.orders set total_amount = (select sum(unit_price*quantity) from public.order_items where order_id=result) where id=result;
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
      update public.orders set recipient_name=$4,phone=$5 where id=$1;
      update public.order_items set unit_price=($2->0->>'price')::numeric
        where id=(select id from public.order_items where order_id=$1 order by unit_price desc limit 1);
      update public.orders set total_amount=(select sum(unit_price*quantity) from public.order_items where order_id=$1) where id=$1;
      return $1;
    end; $$;
    create function public.admin_split_order_items(uuid,uuid[]) returns text language plpgsql as $$
    declare new_id uuid; result text;
    begin
      if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
      insert into public.orders(recipient_name,phone) select recipient_name,phone from public.orders where id=$1 returning id,order_number into new_id,result;
      update public.order_items set order_id=new_id where order_id=$1 and id=any($2);
      update public.orders set total_amount=(select coalesce(sum(unit_price*quantity),0) from public.order_items where order_id=$1) where id=$1;
      update public.orders set total_amount=(select coalesce(sum(unit_price*quantity),0) from public.order_items where order_id=new_id) where id=new_id;
      return result;
    end; $$;
  `);
  await db.exec(await readFile(new URL('../supabase/order_deposit_upgrade.sql', import.meta.url),'utf8'));
  const migration = await readFile(new URL('../supabase/order_deposit_details_upgrade.sql', import.meta.url),'utf8');
  await db.exec(migration); await db.exec(migration);
  const place = (items, deposit, note, deduction) => db.query('select public.place_order_with_deposit_details($1,$2,$3,$4,$5::jsonb,$6,$7,$8) as id',['同名','','面交取貨','',JSON.stringify(items),deposit,note,deduction]);
  const orderId = (await place([{price:1000,quantity:1},{price:500,quantity:1}],2000,'已收轉帳',200)).rows[0].id;
  const read = async () => (await db.query('select recipient_name,total_amount,deposit_amount,deposit_note,deposit_deduction from public.orders where id=$1',[orderId])).rows[0];
  assert.deepEqual([Number((await read()).total_amount),Number((await read()).deposit_amount),(await read()).deposit_note],[1300,2000,'已收轉帳']);
  await assert.rejects(place([{price:100,quantity:1}],200,'',101),/DEDUCTION_EXCEEDS_PRODUCTS/);
  await assert.rejects(place([{price:100,quantity:1}],0,'有備註',0),/DEPOSIT_REQUIRED_FOR_DETAILS/);
  assert.equal((await db.query('select count(*)::int as n from public.orders')).rows[0].n,1);
  await assert.rejects(db.query('select public.admin_save_order_with_deposit_details($1,$2::jsonb,$3,$4,$5,$6,$7,$8)',[orderId,JSON.stringify([{price:800}]),'面交取貨','改名','',2000,'修改',1301]),/DEDUCTION_EXCEEDS_PRODUCTS/);
  assert.equal((await read()).recipient_name,'同名');
  await db.query('select public.admin_save_order_with_deposit_details($1,$2::jsonb,$3,$4,$5,$6,$7,$8)',[orderId,JSON.stringify([{price:1000}]),'面交取貨','同名','',2000,'後台更新',250]);
  assert.equal(Number((await read()).total_amount),1250);
  assert.equal((await read()).deposit_note,'後台更新');
  const secondItem = (await db.query('select id from public.order_items where order_id=$1 and unit_price=500',[orderId])).rows[0].id;
  const newNumber = (await db.query('select public.admin_split_order_with_deposit_details($1,$2::uuid[]) as n',[orderId,[secondItem]])).rows[0].n;
  assert.equal(Number((await read()).total_amount),750);
  assert.equal(Number((await read()).deposit_deduction),250);
  assert.equal(Number((await db.query('select total_amount from public.orders where order_number=$1',[newNumber])).rows[0].total_amount),500);
  await db.query('select public.admin_refund_order_deposits($1::uuid[],$2,$3::date,$4,$5)',[[orderId],1750,'2026-10-01','我',null]);
  await assert.rejects(db.query('select public.admin_refund_order_deposits($1::uuid[],$2,$3::date,$4,$5)',[[orderId],1,'2026-10-01','我',null]),/REFUND_EXCEEDS_DEPOSIT/);
  await assert.rejects(db.query('select public.admin_save_order_with_deposit_details($1,$2::jsonb,$3,$4,$5,$6,$7,$8)',[orderId,JSON.stringify([{price:1000}]),'面交取貨','同名','',2000,'',300]),/DEPOSIT_BELOW_REFUNDED/);
  assert.equal(Number((await read()).deposit_deduction),250);
  await db.exec("select set_config('test.admin','false',false)");
  await assert.rejects(db.query('select public.admin_save_order_with_deposit_details($1,$2::jsonb,$3,$4,$5,$6,$7,$8)',[orderId,JSON.stringify([{price:1000}]),'面交取貨','同名','',2000,'',0]),/ADMIN_REQUIRED/);
  console.log('PASS PostgreSQL: note, unlimited deposit, deduction total, rollback, admin edit, split preservation, permissions');
} finally { await db.close(); }
