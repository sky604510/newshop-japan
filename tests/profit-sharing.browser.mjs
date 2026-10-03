import { createRequire } from 'node:module';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const output = await mkdtemp(join(tmpdir(), 'newshop-profit-test-'));
const source = await readFile(new URL('../profit-sharing.js', import.meta.url), 'utf8');
const css = (await readFile(new URL('../styles.css', import.meta.url), 'utf8')).replace(/^@import[^\r\n]+\r?\n/, '');
try {
  for (const width of [1366, 390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.route('http://localhost/profit-test', (route) => route.fulfill({ contentType: 'text/html', body: `<meta charset="utf-8"><style>${css}</style><nav class="admin-tabs">${Array.from({length:7},()=>'<button>管理分頁</button>').join('')}</nav><div id="fixture" style="padding:16px"></div>` }));
    await page.goto('http://localhost/profit-test');
    await page.evaluate(async (moduleSource) => {
      const { createProfitSharing, calculateProfitShare } = await import(`data:text/javascript;base64,${btoa(unescape(encodeURIComponent(moduleSource)))}`);
      const records = [];
      const state = { products: [{id:'product1',image_url:'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="48" height="48"%3E%3Crect width="48" height="48" fill="pink"/%3E%3C/svg%3E'}], user: { id: 'admin' }, profile: { role: 'owner' }, orders: [
        { id: 'order1', order_number: 'NS-TEST-1', recipient_name: '測試收件人', status: 'confirmed', order_items: [{ id: 'a', product_id:'product1', product_name: '測試商品 <限量款>', quantity: 1, unit_price: 1500, unit_cost: 1000 }, { id: 'b', product_name: '待發貨不能分潤', quantity: 1, unit_price: 500, unit_cost: 100 }] },
        { id: 'order2', order_number: 'NS-TEST-2', status: 'confirmed', order_items: [{ id: 'c', product_name: '已發貨不能分潤', quantity: 1, unit_price: 500, unit_cost: 100 }] },
      ], procurementChecks: new Map([['product1',{is_purchased:true}]]), fulfillmentChecks: new Map([['a', { shipped_at: '2026-09-30', completed_at: '2026-10-01' }], ['c', { shipped_at: '2026-09-30' }]]) };
      const supabase = { from: () => ({ select: () => ({ order: async () => ({ data: structuredClone(records) }) }) }), rpc: async (name, args) => {
        if (name !== 'admin_complete_profit_share_v2' || args.p_item_ids.join() !== 'a') throw new Error('Incorrect settlement request');
        window.lastProfitRequest = args;
        const snapshot = calculateProfitShare(args.p_settings.expected_items, args.p_settings); snapshot.title = args.p_settings.title;
        const data = { id: 'saved', completed_at: new Date().toISOString(), snapshot }; records.push(data); return { data: innerWidth < 600 ? [data] : data };
      } };
      const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
      let controller;
      const render = () => { document.querySelector('#fixture').innerHTML = controller.panel() + (state.modal ? controller.modal() : ''); controller.bind(); };
      controller = createProfitSharing({ state, supabase, esc, money: (value) => `NT$ ${Number(value).toLocaleString('zh-TW')}`, getCost: (item) => item.unit_cost, render, toast: (message) => { window.lastProfitToast = message; }, reload: async () => {}, bindBackdropClose: () => {} });
      await controller.load(); render(); window.profitFixture = { controller, state, render };
    }, source);
    assert.equal(await page.locator('[data-profit-product]').count(), 1);
    assert.equal(await page.locator('.profit-item-thumb img').count(), 1);
    assert.equal(await page.locator('[data-profit-title]').count(), 0, 'First step shows selection only');
    assert.ok(await page.locator('[data-profit-next]').isDisabled());
    await page.locator('[data-profit-market]').check();
    await page.screenshot({ path:join(output, `selection-${width}.png`) });
    await page.locator('[data-profit-next]').click();
    assert.equal(await page.locator('[data-profit-party]').count(), 1);
    assert.equal(await page.locator('[data-profit-ratio]').inputValue(), '100');
    await page.locator('[data-profit-title]').fill('測試分潤批次');
    await page.screenshot({path:join(output, `settings-${width}.png`),fullPage:true});
    await page.locator('[data-profit-add-party]').click();
    assert.deepEqual(await page.locator('[data-profit-ratio]').evaluateAll(rows=>rows.map(row=>row.value)), ['50','50']);
    await page.locator('[data-profit-add-party]').click();
    assert.deepEqual(await page.locator('[data-profit-ratio]').evaluateAll(rows=>rows.map(row=>row.value)), ['34','33','33']);
    assert.ok(await page.locator('.profit-party-table').evaluate(el=>el.getBoundingClientRect().width<=el.parentElement.clientWidth+1), 'Participant table fits without horizontal scrolling');
    await page.screenshot({path:join(output,`participants-${width}.png`),fullPage:true});
    await page.locator('[data-profit-remove-party="2"]').click();
    await page.locator('[data-profit-name]').nth(0).fill('我');
    await page.locator('[data-profit-name]').nth(1).fill('老婆');
    await page.locator('[data-profit-back="select"]').click();
    assert.ok(await page.locator('[data-profit-market]').isChecked(), 'Back retains selection');
    await page.locator('[data-profit-next]').click();
    assert.equal(await page.locator('[data-profit-title]').inputValue(), '測試分潤批次');
    await page.locator('[data-profit-collector]').selectOption('1');
    await page.locator('[data-profit-add-expense]').click();
    await page.locator('[data-profit-expense-name]').fill('集運費');
    await page.locator('[data-profit-expense-amount]').fill('100');
    await page.locator('[data-profit-expense-payer]').selectOption('1');
    await page.locator('[data-profit-confirmed]').check();
    await page.locator('[data-profit-title]').fill('測試分潤批次');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Pending page must fit viewport');
    await page.locator('[data-profit-ratio]').nth(0).fill('49');
    await page.locator('[data-profit-calculate]').click();
    assert.match(await page.evaluate(()=>window.lastProfitToast), /100%/);
    await page.locator('[data-profit-ratio]').nth(0).fill('50.5');
    await page.locator('[data-profit-calculate]').click();
    assert.match(await page.evaluate(()=>window.lastProfitToast), /整數/);
    await page.locator('[data-profit-ratio]').nth(0).fill('50');
    await page.locator('[data-profit-add-party]').click();
    await page.locator('[data-profit-collector]').selectOption('2');
    await page.locator('[data-profit-calculate]').click();
    assert.match(await page.locator('.profit-transfer').textContent(), /分潤人3 應轉給 我 NT\$ 1,136/);
    assert.match(await page.locator('.profit-transfer').textContent(), /分潤人3 應轉給 老婆 NT\$ 232/);
    await page.locator('[data-profit-back="settings"]').click();
    await page.locator('[data-profit-remove-party="2"]').click();
    assert.equal(await page.locator('[data-profit-collector]').inputValue(),'0', 'Removing collector remaps to first participant');
    await page.locator('[data-profit-collector]').selectOption('1');
    await page.locator('[data-profit-calculate]').click();
    assert.match(await page.locator('.profit-transfer').textContent(), /老婆 應轉給 我 NT\$ 1,200/);
    assert.equal(await page.locator('.profit-result-items .profit-item-thumb img').count(), 1);
    assert.equal(await page.locator('.modal-backdrop').count(), 0, 'Calculation moves to result page, not a popup');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth), 'Result page fits viewport');

    await page.screenshot({ path: join(output, `result-${width}.png`) });
    await page.locator('[data-profit-finish]').click();
    await page.locator('[data-profit-history]').waitFor();
    assert.match(await page.locator('.profit-history').textContent(), /分潤時間/);
    await page.locator('[data-profit-history]').click();
    assert.equal(await page.locator('.profit-result-items .profit-item-thumb img').count(), 1);
    assert.match(await page.locator('.profit-transfer').textContent(), /1,200/);
    await page.locator('[data-profit-close]').click();
    await page.locator('[data-profit-view="pending"]').click();
    assert.equal(await page.locator('[data-profit-product]').count(), 0);
    const warning = await page.evaluate(() => window.profitFixture.controller.restoreWarning(['a']));
    assert.equal(warning.count, 1);
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}px: completed-only, extra cost, preview, save, history, exclusion, restore warning`);
    await page.close();
  }
  console.log(`Screenshots: ${output}`);
} finally { await browser.close(); }
