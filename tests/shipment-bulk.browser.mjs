import { createRequire } from 'node:module';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const source = (await readFile(new URL('../app.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '').replace(/render\(\);\r?\ninitialize\(\);\s*$/, '');
const css = (await readFile(new URL('../styles.css', import.meta.url), 'utf8')).replace(/^@import[^\r\n]+\r?\n/, '');
const output = await mkdtemp(join(tmpdir(), 'newshop-reconciliation-'));
try {
  for (const width of [1366, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.route('http://localhost/bulk-test', (route) => route.fulfill({ contentType: 'text/html', body: `<style>${css}</style><div id="app"></div>` }));
    await page.goto('http://localhost/bulk-test');
    await page.evaluate((appSource) => {
      const records = [{order_item_id:'itemD',shipped_at:'2026-10-01',completed_at:'2026-10-02',reconciled_at:null}]; window.shipCalls = [];
      const createClient = () => ({ auth: { onAuthStateChange() {} }, from: () => ({ select: async () => ({ data: structuredClone(records) }) }), rpc: async (name, args) => {
        window.shipCalls.push({ name, args });
        await new Promise((resolve) => setTimeout(resolve, 100));
        args.p_order_item_ids.forEach(id => {
          if (name === 'admin_ship_order_items') records.push({order_item_id:id,shipped_at:args.p_shipped_at,completed_at:null,reconciled_at:null});
          else {
            const record = records.find(row=>row.order_item_id===id);
            if (name === 'admin_set_shipment_items_completed') { record.completed_at=args.p_completed?'2026-10-05':null; record.reconciled_at=null; }
            else if (name === 'admin_reconcile_shipment_items') record.reconciled_at=args.p_reconciled?'2026-10-05':null;
            else throw new Error('Unexpected RPC '+name);
          }
        });
        return { error: null };
      } });
      const createProfitSharing = () => ({ bind() {}, capture() {}, load() {}, restoreWarning:async()=>({count:0,message:''}) });
      const createDepositManagement = () => ({ bind() {}, load() {} });
      eval(appSource + `
        state.user = { id: 'admin', email: 'admin@test' }; state.profile = { role: 'owner' };
        state.view = 'admin'; state.adminTab = 'shipments'; state.loading = false;
        state.orders = ['A','B','C','D'].map((id,index) => ({ id, order_number: 'NS-'+id, recipient_name: '收件人'+id, phone: '', status: 'confirmed', delivery_method: '面交取貨', total_amount: 100,
          order_items: [{ id: 'item'+id, product_name: '商品'+id, quantity: index === 0 ? 2 : 1, unit_price: 100, unit_cost: 50 }] }));
        state.fulfillmentChecks=new Map(records.map(row=>[row.order_item_id,row]));
        state.shipmentSelection.add('stale-id'); render();
      `);
    }, source);
    const button = page.locator('[data-ship-selected]');
    const nav = await page.locator('[data-admin-tab]').evaluateAll(buttons=>buttons.map(button=>button.dataset.adminTab));
    assert.ok(nav.indexOf('deposits')<nav.indexOf('profits'));
    assert.deepEqual(await page.locator('[data-shipment-view]').allTextContents(),['待發貨','發貨中','待收款','已完成']);
    await page.locator('[data-shipment-view="awaiting"]').click();
    assert.equal(await page.locator('[data-reconcile-recipient="D"]').count(),1,'Legacy completed data appears in awaiting payment');
    await page.locator('[data-shipment-view="completed"]').click();
    assert.equal(await page.locator('[data-unreconcile-recipient]').count(),0,'Legacy data does not skip reconciliation');
    await page.locator('[data-shipment-view="pending"]').click();
    assert.equal(await button.count(), 1);
    assert.equal(await page.locator('[data-ship-recipient]').count(), 0);
    assert.equal(await page.locator('.shipment-table thead th').count(), 5);
    assert.equal(await button.textContent(), '發貨（0）');
    assert.ok(await button.isDisabled());
    await page.locator('[data-shipment-select="itemA"]').check();
    await page.locator('[data-shipment-select="itemB"]').check();
    assert.equal(await button.textContent(), '發貨（2）');
    await page.locator('[data-shipment-select="itemB"]').uncheck();
    assert.equal(await button.textContent(), '發貨（1）');
    await page.locator('[data-shipment-select="itemB"]').check();
    page.once('dialog', (dialog) => dialog.dismiss());
    await button.click();
    assert.equal(await page.evaluate(() => window.shipCalls.length), 0);
    assert.equal(await button.textContent(), '發貨（2）');
    page.once('dialog', (dialog) => dialog.accept());
    await button.click();
    await page.waitForFunction(() => document.querySelector('[data-ship-selected]').textContent === '發貨（0）');
    const calls = await page.evaluate(() => window.shipCalls);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'admin_ship_order_items');
    assert.deepEqual(calls[0].args.p_order_item_ids, ['itemA', 'itemB']);
    assert.equal(await page.locator('[data-shipment-select]').count(), 1);
    assert.equal(await page.locator('[data-shipment-select="itemC"]').count(), 1);
    assert.ok(await button.isDisabled());
    assert.ok(await page.evaluate(() => !!document.querySelector('.shipment-header-actions [data-ship-selected]')));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.locator('[data-shipment-view="shipped"]').click();
    assert.equal(await button.count(), 0);
    assert.equal(await page.locator('[data-restore-shipment]').count(), 2);
    await page.locator('[data-complete-recipient="A"]').check();
    assert.match(await page.locator('[data-complete-selected]').textContent(),/待收款/);
    page.once('dialog',dialog=>dialog.accept());
    await page.locator('[data-complete-selected]').click();
    await page.waitForFunction(()=>document.querySelector('[data-complete-recipient="A"]')===null);
    await page.locator('[data-shipment-view="awaiting"]').click();
    assert.equal(await page.locator('[data-reconcile-recipient]').count(),2);
    await page.screenshot({path:join(output,`awaiting-${width}.png`),fullPage:true});
    page.once('dialog',dialog=>dialog.dismiss());
    await page.locator('[data-reconcile-recipient="A"]').click();
    assert.equal(await page.evaluate(()=>window.shipCalls.length),2,'Cancel does not reconcile');
    page.once('dialog',dialog=>dialog.accept());
    await page.locator('[data-reconcile-recipient="A"]').click();
    await page.waitForFunction(()=>document.querySelector('[data-reconcile-recipient="A"]')===null);
    await page.locator('[data-shipment-view="completed"]').click();
    assert.equal(await page.locator('[data-unreconcile-recipient="A"]').count(),1);
    await page.screenshot({path:join(output,`completed-${width}.png`),fullPage:true});
    page.once('dialog',dialog=>dialog.accept());
    await page.locator('[data-unreconcile-recipient="A"]').click();
    await page.waitForFunction(()=>document.querySelector('[data-unreconcile-recipient="A"]')===null);
    await page.locator('[data-shipment-view="awaiting"]').click();
    assert.equal(await page.locator('[data-reconcile-recipient="A"]').count(),1);
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}px: navigation swap, preserved legacy data, shipping, awaiting payment, reconciliation, cancel and restore`);
    await page.close();
  }
  console.log(`Screenshots: ${output}`);
} finally { await browser.close(); }
