import { createRequire } from 'node:module';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const source = (await readFile(new URL('../app.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '').replace(/render\(\);\r?\ninitialize\(\);\s*$/, '');
const deposits = await readFile(new URL('../deposit-management.js', import.meta.url), 'utf8');
const css = (await readFile(new URL('../styles.css', import.meta.url), 'utf8')).replace(/^@import[^\r\n]+\r?\n/, '');
const output = await mkdtemp(join(tmpdir(), 'newshop-deposit-preview-'));
try {
  for (const width of [1366, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 844 }, hasTouch: width < 600 });
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.route('http://localhost/deposit-test', (route) => route.fulfill({ contentType: 'text/html', body: `<style>${css}</style><div id="app"></div>` }));
    await page.goto('http://localhost/deposit-test');
    await page.evaluate(async ({ appSource, depositSource }) => {
      const { createDepositManagement } = await import(URL.createObjectURL(new Blob([depositSource], { type: 'text/javascript' })));
      const orderItems = [{ id: 'item1', product_id: 'p1', market_id: 'm1', product_name: '商品', unit_cost: 300, unit_price: 1000, quantity: 1, subtotal: 1000 }];
      const records = [
        { id: 'o1', order_number: 'NS-1', recipient_name: '同名', phone: '', delivery_method: '面交取貨', status: 'pending', deposit_amount: 200, deposit_deduction: 100, deposit_note: '原訂金備註', total_amount: 900, order_items: orderItems },
        { id: 'o2', order_number: 'NS-2', recipient_name: '同名', phone: '', delivery_method: '面交取貨', status: 'pending', deposit_amount: 300, total_amount: 500, order_items: [] },
      ];
      const refunds = []; window.dbCalls = [];
      const createClient = () => ({ auth: { onAuthStateChange() {} }, from: (table) => ({ select: () => ({ order: async () => ({ data: structuredClone(table === 'order_deposit_refunds' ? refunds : records) }) }) }), rpc: async (name, args) => {
        window.dbCalls.push({ name, args });
        if (name !== 'admin_refund_order_deposits') return { error: { message: 'TEST_STOP' } };
        const batch = crypto.randomUUID(); let left = args.p_amount;
        for (const id of args.p_order_ids) {
          const order = records.find((entry) => entry.id === id);
          const already = refunds.filter((row) => row.order_id === id).reduce((sum, row) => sum + row.amount, 0);
          const amount = Math.min(left, order.deposit_amount - (order.deposit_deduction || 0) - already);
          if (amount > 0) refunds.push({ id: crypto.randomUUID(), batch_id: batch, order_id: id, order_number: order.order_number, recipient_name: order.recipient_name, phone: order.phone, amount, refund_date: args.p_refund_date, refund_source: args.p_refund_source, refund_account: args.p_refund_account, created_at: new Date().toISOString() });
          left -= amount;
        }
        return { data: batch, error: null };
      } });
      const createProfitSharing = () => ({ bind() {}, capture() {}, load() {}, panel() { return ''; }, modal() { return ''; } });
      eval(appSource + `
        state.user = { id: 'member', email: 'buyer@example.com' }; state.profile = { role: 'member' }; state.loading = false;
        state.cart = [{ id: 'p1', product_id: 'p1', market_id: 'm1', name: '商品', price: 1000, qty: 1, stock: 10 }];
        state.orders = records; state.customers = [{ id: 'c1', recipient_name: '常客', phone: '', delivery_method: '面交取貨', is_regular: true }];
        state.modal = 'checkout'; render(); window.testHooks = { state, render, openOrderEditor, depositManagement, shipmentSummaries, statementSnapshotCanvas };
      `);
    }, { appSource: source, depositSource: deposits });
    const check = page.locator('#checkout-has-deposit');
    assert.equal(await check.isChecked(), false);
    assert.equal(await page.locator('#checkout-deposit-field').isVisible(), false);
    await check.check();
    assert.equal(await page.locator('#checkout-deposit-field').isVisible(), true);
    await page.locator('#customer').fill('一般買家');
    await page.locator('#checkout-deposit-amount').fill('5000');
    await page.locator('#checkout-deposit-note').fill('已收轉帳');
    await page.locator('#checkout-deduct-product').check();
    await page.locator('#checkout-deduction-amount').fill('200');
    assert.match(await page.locator('[data-action="checkout"]').textContent(), /NT\$ 800/);
    await page.locator('[data-action="checkout"]').click();
    let calls = await page.evaluate(() => window.dbCalls);
    assert.equal(calls[0].name, 'place_order_with_deposit_details');
    assert.equal(calls[0].args.p_deposit_amount, 5000);
    assert.equal(calls[0].args.p_deposit_note, '已收轉帳');
    assert.equal(calls[0].args.p_deduction_amount, 200);
    await page.evaluate(() => { window.testHooks.state.profile.role = 'owner'; window.testHooks.render(); });
    await page.locator('[data-checkout-mode="regular"]').click();
    await page.locator('#regular-customer').selectOption('c1');
    assert.equal(await page.locator('#checkout-deposit-amount').inputValue(), '5000');
    await page.locator('[data-action="checkout"]').click();
    calls = await page.evaluate(() => window.dbCalls);
    assert.equal(calls[1].name, 'admin_place_order_with_deposit_details');
    assert.equal(calls[1].args.p_customer_id, 'c1');
    assert.equal(calls[1].args.p_deposit_amount, 5000);
    assert.equal(calls[1].args.p_deduction_amount, 200);
    await page.evaluate(() => { window.testHooks.state.view = 'admin'; window.testHooks.state.modal = null; window.testHooks.openOrderEditor('o1'); });
    assert.equal(await page.locator('#order-deposit-amount').inputValue(), '200');
    await page.locator('#order-deposit-amount').fill('10000');
    await page.locator('#order-deposit-note').fill('後台修改');
    await page.locator('#order-deduct-product').check();
    await page.locator('#order-deduction-amount').fill('100');
    assert.match(await page.locator('[data-order-draft-total]').textContent(), /NT\$ 900/);
    await page.locator('[data-action="save-order-editor"]').click();
    calls = await page.evaluate(() => window.dbCalls);
    assert.equal(calls[2].name, 'admin_save_order_with_deposit_details');
    assert.equal(calls[2].args.p_deposit_amount, 10000);
    assert.equal(calls[2].args.p_deposit_note, '後台修改');
    assert.equal(calls[2].args.p_deduction_amount, 100);
    await page.evaluate(async () => { const { state, render, depositManagement } = window.testHooks; state.modal = null; state.adminTab = 'deposits'; await depositManagement.load(); render(); });
    assert.equal(await page.locator('.deposit-group').count(), 1);
    assert.match(await page.locator('.deposit-group').textContent(), /總訂金 NT\$ 500/);
    assert.match(await page.locator('.deposit-group').textContent(), /可退訂金 NT\$ 400/);
    assert.match(await page.locator('.deposit-group').textContent(), /原訂金備註/);
    const link = page.locator('[data-deposit-order="o1"]');
    if (width >= 600) {
      await link.hover();
      await page.locator('.deposit-order-preview').waitFor();
      assert.match(await page.locator('.deposit-order-preview').textContent(),/商品 × 1/);
      assert.doesNotMatch(await page.locator('.deposit-order-preview').textContent(),/NT\$|300|1000/);
      await page.screenshot({path:join(output,`preview-${width}.png`)});
      await page.mouse.move(0,0);
      assert.equal(await page.locator('.deposit-order-preview').count(),0);
      await link.click();
    } else {
      await link.scrollIntoViewIfNeeded();
      const rect = await link.boundingBox(), x=rect.x+rect.width/2, y=rect.y+rect.height/2;
      const touch = await page.context().newCDPSession(page);
      await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
      await page.locator('.deposit-order-preview').waitFor();
      assert.match(await page.locator('.deposit-order-preview').textContent(),/商品 × 1/);
      await page.screenshot({path:join(output,`preview-${width}.png`)});
      await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+25,y}]});
      await page.waitForFunction(()=>!document.querySelector('.deposit-order-preview'));
      await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      assert.equal(await page.locator('.order-editor-modal').count(),0,'Sliding after long press must not navigate');
      await link.tap();
    }
    await page.locator('.order-editor-modal').waitFor();
    assert.match(await page.locator('.order-editor-modal h2').textContent(),/NS-1/);
    assert.equal(await page.locator('[data-admin-tab="orders"]').getAttribute('class'),'active');
    assert.equal(await page.locator('.deposit-order-preview').count(),0);
    await page.locator('[data-action="close-order-editor"]').first().click();
    await page.evaluate(()=>{window.testHooks.state.adminTab='deposits';window.testHooks.render();});
    await page.locator('[data-deposit-refund]').click();
    assert.equal(await page.locator('#deposit-refund-amount').inputValue(), '400');
    await page.locator('#deposit-refund-amount').fill('250');
    await page.locator('#deposit-refund-source').fill('我');
    await page.locator('#deposit-refund-account').fill('銀行尾號1234');
    await page.locator('[data-deposit-confirm]').click();
    calls = await page.evaluate(() => window.dbCalls);
    assert.equal(calls[3].name, 'admin_refund_order_deposits');
    assert.equal(calls[3].args.p_amount, 250);
    assert.match(await page.locator('.deposit-group').textContent(), /已退 NT\$ 250/);
    assert.match(await page.locator('.deposit-group').textContent(), /銀行尾號1234/);
    assert.equal(await page.locator('.deposit-group--refunded').count(),1);
    assert.equal(await page.locator('.deposit-group--refunded').evaluate(el=>getComputedStyle(el).display),'grid');
    await page.screenshot({path:join(output,`refunded-${width}.png`),fullPage:true});
    await page.locator('[data-deposit-view="received"]').click();
    assert.match(await page.locator('.deposit-group').textContent(), /可退訂金 NT\$ 150/);
    const snapshot = await page.evaluate(async () => {
      const { state, shipmentSummaries, statementSnapshotCanvas } = window.testHooks;
      state.orders[0].deposit_deduction = 100;
      state.orders[0].deposit_note = '測試訂金備註';
      state.fulfillmentChecks.set('item1', { shipped_at: '2026-10-01', completed_at: null });
      const recipient = shipmentSummaries('shipped')[0];
      const drawn = [];
      const original = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function (text, ...args) { drawn.push(String(text)); return original.call(this, text, ...args); };
      try { await statementSnapshotCanvas(recipient); }
      finally { CanvasRenderingContext2D.prototype.fillText = original; }
      return { amount: recipient.amount, deduction: recipient.deduction, drawn };
    });
    assert.equal(snapshot.amount, 900);
    assert.equal(snapshot.deduction, 100);
    assert.ok(snapshot.drawn.some((line) => line.includes('測試訂金備註')));
    assert.ok(snapshot.drawn.some((line) => line.includes('總金額 NT$ 900')));
    assert.ok(snapshot.drawn.every((line) => !/NS-1|NS-2/.test(line)), 'Snapshot must not display order numbers');
    await page.evaluate(() => { window.testHooks.state.adminTab = 'shipments'; window.testHooks.state.shipmentView = 'shipped'; window.testHooks.render(); });
    assert.match(await page.locator('.shipment-deposit-info').textContent(), /測試訂金備註/);
    assert.match(await page.locator('.shipment-table tbody tr').textContent(), /NT\$ 900/);
    const splitStages = await page.evaluate(() => {
      const { state, shipmentSummaries } = window.testHooks;
      state.orders[0].deposit_amount = 400;
      state.orders[0].deposit_deduction = 300;
      state.orders[0].order_items.push({ id: 'item2', product_id: 'p2', market_id: 'm1', product_name: '第二商品', unit_cost: 100, unit_price: 500, quantity: 1, subtotal: 500 });
      return [shipmentSummaries('shipped')[0].amount, shipmentSummaries('pending').find((recipient) => recipient.recipient === '同名').amount];
    });
    assert.deepEqual(splitStages, [800, 400]);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}px: general and regular checkout, unlimited note, admin edit, recipient refund, partial balance`);
    await page.close();
  }
  console.log(`Screenshots: ${output}`);
} finally { await browser.close(); }
