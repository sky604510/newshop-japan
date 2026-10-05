import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { calculateProfitShare } from '../profit-sharing.js';
const { PGlite } = createRequire(import.meta.url)('@electric-sql/pglite');
const db = new PGlite();
const product = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
try {
  // The existing v2 migration is absent from this checkout. This fixture
  // isolates the new wrapper; production v2 still validates item eligibility.
  await db.exec(`
    create role anon; create role authenticated; create schema auth;
    create function auth.uid() returns uuid language sql as $$ select null::uuid $$;
    create function public.is_admin() returns boolean language sql as $$ select coalesce(current_setting('test.admin',true),'true')::boolean $$;
    create table public.products(id uuid primary key);
    create table public.orders(id uuid primary key,status text);
    create table public.order_items(id uuid primary key,order_id uuid,product_id uuid,quantity integer);
    create table public.procurement_checks(product_id uuid primary key,is_purchased boolean not null default false,updated_by uuid,updated_at timestamptz default now());
    create table public.profit_share_settlements(id uuid primary key default gen_random_uuid(),completed_at timestamptz default now(),snapshot jsonb);
    create function public.admin_complete_profit_share_v2(p_item_ids uuid[], p_settings jsonb)
    returns setof public.profit_share_settlements language sql as $$
      insert into public.profit_share_settlements(snapshot) values (p_settings->'fixture_snapshot') returning *;
    $$;
    insert into public.products values ('${product}');
    insert into public.orders values ('${product}','confirmed');
    insert into public.order_items values ('${id}','${product}','${product}',3);
    insert into public.procurement_checks(product_id,is_purchased) values ('${product}',true);
  `);
  const migration = await readFile(new URL('../supabase/procurement_cost_people_upgrade.sql',import.meta.url),'utf8');
  await db.exec(migration); await db.exec(migration);
  const save = (allocation) => db.query('select public.admin_set_procurement_cost_people($1::jsonb)',[JSON.stringify([{product_id:product,cost_allocations:{[id]:allocation}}])]);
  for (const invalid of [[1,1],[null,null],[-1,4],[1.5,1.5]]) await assert.rejects(save(invalid));
  await save([2,1]);
  assert.equal((await db.query('select is_purchased from public.procurement_checks')).rows[0].is_purchased,true);
  const items = [{id,product_id:product,quantity:3,unit_cost:1330,unit_price:1550}];
  const settings = {parties:[{name:'豪',ratio:50},{name:'盈',ratio:50}],collector:1,received:4650,receivedConfirmed:true,payers:{[id]:0},expenses:[{description:'運費',amount:100,payer:1}]};
  const fixture = calculateProfitShare(items,settings);
  const run = (allocation,extra={}) => db.query('select * from public.admin_complete_profit_share_v3($1::uuid[],$2::jsonb)',[[id],JSON.stringify({...settings,allocations:{[id]:allocation},fixture_snapshot:fixture,...extra})]);
  await assert.rejects(run([1,2]),/PROFIT_COST_ALLOCATION_CHANGED/);
  assert.equal((await db.query('select count(*) from public.profit_share_settlements')).rows[0].count,0);
  const saved = (await run([2,1])).rows[0].snapshot;
  const expected = calculateProfitShare(items,{...settings,allocations:{[id]:[2,1]}});
  assert.deepEqual(saved.parties,expected.parties);
  assert.deepEqual(saved.items[0].allocation,[2,1]);
  assert.equal(saved.profit,fixture.profit);
  await save([0,3]);
  assert.deepEqual((await db.query('select snapshot from public.profit_share_settlements')).rows[0].snapshot,saved,'Historical snapshots remain unchanged');
  await db.exec("select set_config('test.admin','false',false)");
  await assert.rejects(save([3,0]),/ADMIN_REQUIRED/);
  await assert.rejects(run([0,3]),/ADMIN_REQUIRED/);
  console.log('PASS database: migration idempotency, quantity validation, server allocation checks, reimbursements, extra costs, history, permissions');
} finally { await db.close(); }
