import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { calculateProfitShare } from '../profit-sharing.js';
const { PGlite } = createRequire(import.meta.url)('@electric-sql/pglite');
const db = new PGlite();
const admin = '11111111-1111-4111-8111-111111111111';
const order = '22222222-2222-4222-8222-222222222222';
const ids = Array.from({ length: 4 }, randomUUID);
try {
  await db.exec(`
    create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key);
    insert into auth.users values ('${admin}');
    create function auth.uid() returns uuid language sql as $$ select '${admin}'::uuid $$;
    create function public.is_admin() returns boolean language sql as $$ select coalesce(current_setting('test.admin', true), 'true')::boolean $$;
    create table public.orders(id uuid primary key, order_number text, recipient_name text, status text, created_at timestamptz default now());
    create table public.order_items(id uuid primary key, order_id uuid references public.orders, product_id uuid, product_name text, quantity integer, unit_price numeric, unit_cost numeric);
    create table public.product_costs(product_id uuid primary key, cost numeric);
    create table public.order_item_fulfillments(order_item_id uuid primary key references public.order_items, shipped_at date, completed_at timestamptz, updated_by uuid, updated_at timestamptz);
    insert into public.orders values ('${order}', 'NS-TEST', '測試收件人', 'confirmed', now());
  `);
  const migration = await readFile(new URL('../supabase/profit_sharing_upgrade.sql', import.meta.url), 'utf8');
  await db.exec(migration); await db.exec(migration);
  async function seed(id, completed = true) {
    await db.query('insert into public.order_items values ($1, $2, null, $3, 1, 1500, 1000)', [id, order, '測試商品']);
    await db.query('insert into public.order_item_fulfillments(order_item_id,shipped_at,completed_at) values ($1,current_date,$2)', [id, completed ? new Date().toISOString() : null]);
  }
  const settings = (id, received = 1500) => ({ title: '測試分潤', parties: [{ name: '我', ratio: 50 }, { name: '老婆', ratio: 50 }], collector: 1, received, receivedConfirmed: true, payers: { [id]: 0 }, expenses: [{ description: '集運', amount: 100, payer: 1 }], expected_items: [{ id, quantity: 1, unit_price: 1500, unit_cost: 1000 }] });
  const settle = (id, config = settings(id)) => db.query('select * from public.admin_complete_profit_share($1::uuid[], $2::jsonb)', [[id], JSON.stringify(config)]);
  await seed(ids[0]); await seed(ids[1], false); await seed(ids[2]); await seed(ids[3]);
  await assert.rejects(settle(ids[1]), /PROFIT_ITEM_STATE_CHANGED/);
  await assert.rejects(settle(ids[2], { ...settings(ids[2]), expected_items: [{ id: ids[2], quantity: 1, unit_price: 1500, unit_cost: 999 }] }), /PROFIT_ITEM_AMOUNT_CHANGED/);
  await assert.rejects(settle(ids[3], { ...settings(ids[3]), receivedConfirmed: false }), /INVALID_PROFIT_SETTINGS/);
  const saved = (await settle(ids[0])).rows[0];
  assert.equal(saved.snapshot.profit, 400);
  assert.deepEqual(saved.snapshot.parties.map((party) => party.balance), [1200, -1200]);
  await assert.rejects(settle(ids[0]), /PROFIT_ITEM_ALREADY_SETTLED/);
  await assert.rejects(db.query('select public.admin_set_shipment_items_completed($1::uuid[], false)', [[ids[0]]]), /PROFIT_RESTORE_CONFIRM_REQUIRED/);
  await db.query('select public.admin_set_shipment_items_completed($1::uuid[], false, true)', [[ids[0]]]);
  assert.equal((await db.query('select completed_at from public.order_item_fulfillments where order_item_id=$1', [ids[0]])).rows[0].completed_at, null);
  await db.query('select public.admin_set_shipment_items_completed($1::uuid[], true)', [[ids[0]]]);
  await assert.rejects(db.query('select public.admin_restore_order_item($1::uuid)', [ids[0]]), /PROFIT_RESTORE_CONFIRM_REQUIRED/);
  await db.query('select public.admin_restore_order_item($1::uuid, true)', [ids[0]]);
  assert.deepEqual((await db.query('select snapshot from public.profit_share_settlements where id=$1', [saved.id])).rows[0].snapshot, saved.snapshot);
  for (const received of [0, 1000.01, 1100.01, 1100.03]) {
    const id = randomUUID(); await seed(id);
    const config = settings(id, received);
    const actual = (await settle(id, config)).rows[0].snapshot;
    const preview = calculateProfitShare(config.expected_items, config);
    assert.deepEqual(actual.parties, preview.parties);
    assert.equal(actual.profit, preview.profit);
  }
  await db.exec('set role authenticated');
  await assert.rejects(db.exec("insert into public.profit_share_settlements(snapshot) values ('{}')"), /permission denied/);
  await db.exec("select set_config('test.admin','false',false)");
  assert.equal((await db.query('select * from public.profit_share_settlements')).rows.length, 0);
  await assert.rejects(settle(ids[2]), /ADMIN_REQUIRED/);
  console.log('PASS PostgreSQL: migration replay, completed-only, stale amounts, duplicate settlement, restore acknowledgment, immutable history, rounding, RLS and admin permissions');
} finally { await db.close(); }
