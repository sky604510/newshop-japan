import { createRequire } from 'node:module';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const source = (await readFile(new URL('../app.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '').replace(/render\(\);\r?\ninitialize\(\);\s*$/, '').replaceAll("await import('https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs')", 'window.XLSX');
const xlsx = await readFile(new URL('../assets/xlsx-style.bundle.js', import.meta.url), 'utf8');
const css = (await readFile(new URL('../styles.css', import.meta.url), 'utf8')).replace(/^@import[^\r\n]+\r?\n/, '');
const output = await mkdtemp(join(tmpdir(), 'newshop-reconciliation-'));
async function checkRecipientCollapse(page, key, width, expectedAmount, expectedProfit) {
  const details = page.locator(`[data-shipment-recipient-details="${key}"]`);
  const summary = page.locator(`[data-shipment-recipient-summary="${key}"]`);
  assert.ok(await details.isVisible());
  await details.locator('[data-shipment-recipient-toggle]').click();
  assert.ok(await details.isHidden());assert.ok(await summary.isVisible());
  assert.ok((await summary.textContent()).includes(`總金額 NT$ ${expectedAmount}`));
  assert.ok((await summary.textContent()).includes(`獲利 NT$ ${expectedProfit}`));
  const bounds = await summary.evaluate(row=>{
    const wrap=row.closest('.table-wrap').getBoundingClientRect(), button=row.querySelector('button').getBoundingClientRect();
    return {right:button.right,wrapRight:wrap.right};
  });
  assert.ok(bounds.right<=bounds.wrapRight+1,'Collapsed recipient totals fit the visible mobile viewport');
  await page.evaluate(()=>window.testHooks.render());
  assert.ok(await summary.isVisible(),'Recipient stays collapsed across a rerender');
  await page.screenshot({path:join(output,`recipient-collapsed-${key.split(':')[0]}-${width}.png`)});
  await summary.locator('button').focus();await summary.locator('button').press('Enter');
  assert.ok(await details.isVisible());assert.ok(await summary.isHidden());
}
async function checkSnapshot(page, selector, title, included, excluded, filename) {
  await page.evaluate(() => {
    window.snapshotDrawn = [];
    if (!window.originalSnapshotFillText) {
      window.originalSnapshotFillText = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function(text, ...args) { window.snapshotDrawn.push(String(text)); return window.originalSnapshotFillText.call(this,text,...args); };
    }
  });
  await page.locator(selector).click();
  const dialog = page.locator('.statement-snapshot-dialog');await dialog.waitFor();
  assert.match(await dialog.locator('.statement-snapshot-actions strong').textContent(),new RegExp(title));
  const drawn = await page.evaluate(()=>window.snapshotDrawn);
  assert.ok(drawn.includes(title));
  for (const name of included) assert.ok(drawn.includes(name),`Snapshot includes ${name}`);
  for (const name of excluded) assert.ok(!drawn.includes(name),`Snapshot excludes ${name}`);
  assert.ok(drawn.every(text=>!/NS-|備註/.test(text)));
  assert.ok((await dialog.locator('a[download]').getAttribute('download')).includes(title));
  await dialog.screenshot({path:join(output,filename)});
  await dialog.locator('[data-close-statement-snapshot]').click();
  assert.equal(await dialog.count(),0);
}
try {
  for (const width of [1366, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.route('http://localhost/bulk-test', (route) => route.fulfill({ contentType: 'text/html', body: `<style>${css}</style><div id="app"></div>` }));
    await page.goto('http://localhost/bulk-test');
    await page.addScriptTag({ content: xlsx });
    await page.evaluate(() => {
      window.exports = [];
      window.XLSX.writeFile = (book, filename) => {
        const saved = window.XLSX.read(window.XLSX.write(book, { type: 'array', bookType: 'xlsx' }), { type: 'array' });
        window.exports.push({ filename, sheets: Object.fromEntries(saved.SheetNames.map(name => [name, window.XLSX.utils.sheet_to_json(saved.Sheets[name], { header: 1 })])) });
      };
    });
    await page.evaluate((appSource) => {
      const records = [{order_item_id:'itemD',shipped_at:'2026-10-01',completed_at:'2026-10-02',reconciled_at:null}]; window.shipCalls = [];
      const createClient = () => ({ auth: { onAuthStateChange() {} }, from: () => ({ select: async (columns) => window.oldBatchSchema && columns.includes('reconciliation_batch_id') ? { error: { message: 'column reconciliation_batch_id does not exist' } } : { data: structuredClone(records) } }), rpc: async (name, args) => {
        window.shipCalls.push({ name, args });
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (name === 'admin_rename_shipment_group') {
          records.filter(record=>record.reconciliation_batch_id===args.p_batch_id).forEach(record=>record.reconciliation_batch_name=args.p_name);
          return { error: null };
        }
        args.p_order_item_ids.forEach(id => {
          if (name === 'admin_ship_order_items') records.push({order_item_id:id,shipped_at:args.p_shipped_at,completed_at:null,reconciled_at:null});
          else {
            const record = records.find(row=>row.order_item_id===id);
            if (name === 'admin_set_shipment_items_completed') { record.completed_at=args.p_completed?'2026-10-05':null; record.reconciled_at=null; }
            else if (name === 'admin_reconcile_shipment_items') { record.reconciled_at=args.p_reconciled?'2026-10-05':null; record.reconciliation_batch_id=args.p_reconciled?'batch-0001':null; }
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
        state.shipmentSelection.add('stale-id'); render(); window.testHooks = { state, render, records, loadFulfillmentChecks };
      `);
    }, source);
    const button = page.locator('[data-ship-selected]');
    const nav = await page.locator('[data-admin-tab]').evaluateAll(buttons=>buttons.map(button=>button.dataset.adminTab));
    assert.ok(nav.indexOf('deposits')<nav.indexOf('profits'));
    assert.deepEqual(await page.locator('[data-shipment-view]').allTextContents(),['待發貨','發貨中','待收款','已完成']);
    await page.locator('[data-shipment-view="awaiting"]').click();
    assert.equal(await page.locator('[data-reconcile-select="D"]').count(),1,'Legacy completed data appears in awaiting payment');
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
    await checkRecipientCollapse(page,'pending::A',width,200,100);
    assert.ok(await page.locator('[data-shipment-select="itemA"]').isChecked(),'Collapse does not clear selected products');
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
    await checkRecipientCollapse(page,'shipped::A',width,200,100);
    assert.equal(await page.locator('.shipment-recipient-check strong').first().evaluate(el=>getComputedStyle(el).fontSize),'28px');
    assert.equal(await page.locator('.shipment-snapshot').first().evaluate(el=>getComputedStyle(el).fontSize),'14px');
    assert.ok((await page.locator('.shipment-snapshot').first().boundingBox()).height>=38);
    assert.match(await page.locator('.shipment-table').evaluate(el=>getComputedStyle(el).borderSpacing),/14px/);
    await page.screenshot({path:join(output,`recipient-spacing-${width}.png`),fullPage:true});
    await page.locator('[data-complete-recipient="A"]').check();
    assert.match(await page.locator('[data-complete-selected]').textContent(),/待收款/);
    page.once('dialog',dialog=>dialog.accept());
    await page.locator('[data-complete-selected]').click();
    await page.waitForFunction(()=>document.querySelector('[data-complete-recipient="A"]')===null);
    await page.locator('[data-shipment-view="awaiting"]').click();
    assert.equal(await page.locator('[data-reconcile-select]').count(),2);
    await checkRecipientCollapse(page,'awaiting::A',width,200,100);
    await checkSnapshot(page,'[data-shipment-snapshot="A"]','對帳單（待收款）',['商品A'],['商品B','商品D'],`snapshot-awaiting-${width}.png`);
    assert.ok(await page.locator('[data-reconcile-selected]').isDisabled());
    await page.locator('[data-reconcile-select="A"]').check();
    await page.locator('[data-reconcile-select="D"]').check();
    assert.equal(await page.locator('.reconciliation-toolbar').evaluate(el=>getComputedStyle(el).position),'sticky');
    assert.equal(await page.locator('.reconciliation-toolbar').evaluate(el=>getComputedStyle(el).borderRadius),'14px');
    await page.evaluate(() => {
      const panel=document.querySelector('.reconciliation-toolbar').closest('.panel');
      const spacer=document.createElement('div');spacer.style.height='1500px';spacer.id='sticky-test-spacer';panel.append(spacer);
      document.querySelector('.admin-content').scrollTop=900;
    });
    await page.waitForTimeout(100);
    const sticky = await page.evaluate(() => {
      const bar=document.querySelector('.reconciliation-toolbar'), tabs=document.querySelector('.admin-tabs');
      return { top:bar.getBoundingClientRect().top, expected:document.querySelector('.admin-content').getBoundingClientRect().top+parseFloat(getComputedStyle(document.querySelector('.admin-content')).paddingTop)+parseFloat(getComputedStyle(bar).top), tabBottom:tabs.getBoundingClientRect().bottom };
    });
    assert.ok(Math.abs(sticky.top-sticky.expected)<2,'Toolbar remains pinned when scrolling');
    assert.ok(sticky.top>=sticky.tabBottom+9,'Toolbar clears the sticky admin navigation');
    await page.screenshot({path:join(output,`sticky-${width}.png`)});
    await page.evaluate(()=>{document.querySelector('#sticky-test-spacer').remove();document.querySelector('.admin-content').scrollTop=0;});
    assert.match(await page.locator('[data-reconcile-summary]').textContent(),/2 筆・總金額 NT\$ 300・總獲利 NT\$ 150/);
    await page.locator('[data-reconcile-select="D"]').uncheck();
    assert.match(await page.locator('[data-reconcile-summary]').textContent(),/1 筆・總金額 NT\$ 200・總獲利 NT\$ 100/);
    await page.locator('[data-reconcile-select="D"]').check();
    await page.locator('[data-action="export-shipment"]').click();
    const awaitingExport = await page.evaluate(() => window.exports.at(-1));
    assert.match(awaitingExport.filename, /待收款清單/);
    assert.ok(JSON.stringify(awaitingExport.sheets).includes('商品A'));
    assert.ok(JSON.stringify(awaitingExport.sheets).includes('商品D'));
    assert.ok(!JSON.stringify(awaitingExport.sheets).includes('商品B'));
    await page.screenshot({path:join(output,`awaiting-${width}.png`),fullPage:true});
    page.once('dialog',dialog=>dialog.dismiss());
    await page.locator('[data-reconcile-selected]').click();
    assert.equal(await page.evaluate(()=>window.shipCalls.length),2,'Cancel does not reconcile');
    page.once('dialog',dialog=>dialog.accept());
    await page.locator('[data-reconcile-selected]').click();
    assert.ok(await page.locator('[data-reconcile-selected]').isDisabled());
    await page.waitForFunction(()=>document.querySelector('[data-reconcile-select="A"]')===null);
    assert.deepEqual(await page.evaluate(()=>window.shipCalls.at(-1).args.p_order_item_ids),['itemA','itemD']);
    await page.locator('[data-shipment-view="completed"]').click();
    assert.equal(await page.locator('[data-unreconcile-recipient="A"]').count(),1);
    assert.equal(await page.locator('[data-reconciliation-group]').count(),1);
    await checkRecipientCollapse(page,'completed:batch-0001:A',width,200,100);
    const groupToggle = page.locator('[data-group-collapse="reconciliation:batch-0001"]');
    await groupToggle.click();
    assert.ok(await page.locator('[data-unreconcile-recipient="A"]').isHidden());
    assert.ok(await page.locator('.reconciliation-group-head').isVisible());
    await page.evaluate(()=>window.testHooks.render());
    assert.equal(await groupToggle.getAttribute('aria-expanded'),'false');
    await groupToggle.click();
    assert.ok(await page.locator('[data-unreconcile-recipient="A"]').isVisible());
    assert.match(await page.locator('.reconciliation-group-head').textContent(),/總金額 NT\$ 300/);
    assert.match(await page.locator('.reconciliation-group-head').textContent(),/總獲利 NT\$ 150/);
    await page.locator('[data-action="export-shipment"]').click();
    const completedExport = await page.evaluate(() => window.exports.at(-1));
    assert.match(completedExport.filename, /已完成清單/);
    assert.equal(completedExport.sheets.GROUP彙總[1][3],300);
    assert.equal(completedExport.sheets.GROUP彙總[1][4],150);
    assert.equal(completedExport.sheets.已完成清單[0][0],'20261005_0800');
    assert.equal(await page.locator('.reconciliation-group-name h3').textContent(),'20261005_0800');
    const rename = page.locator('[data-rename-shipment-group]');
    page.once('dialog',dialog=>dialog.dismiss());
    await rename.click();
    assert.equal(await page.evaluate(()=>window.shipCalls.at(-1).name),'admin_reconcile_shipment_items','Cancel does not save a name');
    page.once('dialog',dialog=>dialog.accept('   '));
    await rename.click();
    assert.equal(await page.evaluate(()=>window.shipCalls.at(-1).name),'admin_reconcile_shipment_items','Blank names are rejected');
    page.once('dialog',dialog=>dialog.accept('十月第一批對帳'));
    await rename.click();
    await page.waitForFunction(()=>document.querySelector('.reconciliation-group-name h3').textContent==='十月第一批對帳');
    await page.evaluate(async()=>{await window.testHooks.loadFulfillmentChecks();window.testHooks.render();});
    assert.equal(await page.locator('.reconciliation-group-name h3').textContent(),'十月第一批對帳','Rename survives reload');
    await page.locator('[data-action="export-shipment"]').click();
    assert.equal(await page.evaluate(()=>window.exports.at(-1).sheets.已完成清單[0][0]),'十月第一批對帳','Excel uses the edited name');
    await page.screenshot({path:join(output,`completed-${width}.png`),fullPage:true});
    page.once('dialog',dialog=>dialog.accept());
    await page.locator('[data-unreconcile-recipient="A"]').click();
    await page.waitForFunction(()=>document.querySelector('[data-unreconcile-recipient="A"]')===null);
    await page.locator('[data-shipment-view="awaiting"]').click();
    assert.equal(await page.locator('[data-reconcile-select="A"]').count(),1);
    await page.locator('[data-shipment-view="completed"]').click();
    assert.equal(await page.locator('[data-unreconcile-recipient="D"]').count(),1,'Restoring one recipient preserves the other group member');
    assert.match(await page.locator('.reconciliation-group-head').textContent(),/總金額 NT\$ 100/);
    await page.evaluate(async () => {
      const { state, records, loadFulfillmentChecks, render } = window.testHooks;
      state.orders.push({ ...state.orders.find(order=>order.id==='D'), id:'E', order_number:'NS-E', order_items:[{id:'itemE', product_name:'另一批商品',quantity:1,unit_price:500,unit_cost:200}] });
      records.push({order_item_id:'itemE',shipped_at:'2026-10-02',completed_at:'2026-10-03',reconciled_at:'2026-10-06',reconciliation_batch_id:'second-batch'});
      await loadFulfillmentChecks(); render();
    });
    assert.equal(await page.locator('[data-reconciliation-group]').count(),2,'Same recipient in two batches remains in separate groups');
    await page.locator('[data-shipment-recipient-details="completed:second-batch:E"] [data-shipment-recipient-toggle]').click();
    assert.ok(await page.locator('[data-shipment-recipient-details="completed:batch-0001:D"]').isVisible(),'Same recipient in another group is not collapsed');
    await page.locator('[data-shipment-recipient-summary="completed:second-batch:E"] button').click();
    await checkSnapshot(page,'[data-reconciliation-group="second-batch"] [data-shipment-snapshot]','對帳單（已完成）',['另一批商品'],['商品D','商品A'],`snapshot-completed-${width}.png`);
    await checkSnapshot(page,'[data-reconciliation-group="batch-0001"] [data-shipment-snapshot]','對帳單（已完成）',['商品D'],['另一批商品','商品A'],`snapshot-first-batch-${width}.png`);
    page.once('dialog',dialog=>dialog.accept());
    await page.locator('[data-unreconcile-recipient="D"]').click();
    await page.waitForFunction(()=>!document.querySelector('[data-unreconcile-recipient="D"]'));
    assert.equal(await page.locator('[data-unreconcile-recipient="E"]').count(),1,'Restore is scoped to one batch, not all same-name recipients');
    assert.deepEqual(await page.evaluate(()=>window.shipCalls.at(-1).args.p_order_item_ids),['itemD']);
    await page.evaluate(async()=>{window.oldBatchSchema=true;await window.testHooks.loadFulfillmentChecks();window.testHooks.render();});
    assert.equal(await page.locator('[data-unreconcile-recipient="E"]').count(),1,'Existing completed data stays visible on older schemas');
    await page.locator('[data-shipment-view="awaiting"]').click();
    assert.ok(await page.locator('[data-reconcile-select="A"]').isDisabled(),'Missing batch migration cannot silently create ungrouped completion');
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}px: navigation swap, preserved legacy data, shipping, awaiting payment, reconciliation, cancel and restore`);
    await page.close();
  }
  console.log(`Screenshots: ${output}`);
} finally { await browser.close(); }
