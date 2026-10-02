import {createRequire} from 'node:module';
import {readFile,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const {chromium}=createRequire(import.meta.url)('playwright');
const source=(await readFile(new URL('../app.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'').replace(/render\(\);\r?\ninitialize\(\);\s*$/,'');
const moduleSource=await readFile(new URL('../profit-sharing.js',import.meta.url),'utf8');
const css=(await readFile(new URL('../styles.css',import.meta.url),'utf8')).replace(/^@import[^\r\n]+\r?\n/,'');
const browser=await chromium.launch({channel:'msedge',headless:true});
const output=await mkdtemp(join(tmpdir(),'newshop-procurement-profit-'));
try {
  for(const width of [1366,390]) {
    const page=await browser.newPage({viewport:{width,height:900}});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.route('http://localhost/purchase-test',route=>route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><style>${css}</style><div id="app"></div>`}));
    await page.goto('http://localhost/purchase-test');
    await page.evaluate(async ({source,moduleSource})=>{
      const {createProfitSharing}=await import(URL.createObjectURL(new Blob([moduleSource],{type:'text/javascript'})));
      const tables={
        markets:[{id:'m1',name:'測試賣場',is_active:true,products:[{id:'p1',market_id:'m1',name:'已採購未發貨商品',price:1500,stock:3,is_active:true},{id:'p2',market_id:'m1',name:'未採購已發貨商品',price:100,stock:3,is_active:true}]}],
        orders:[{id:'o1',order_number:'NS-PURCHASE',recipient_name:'測試收件人',status:'confirmed',total_amount:1600,order_items:[{id:'a',product_id:'p1',market_id:'m1',product_name:'已採購未發貨商品',unit_price:1500,unit_cost:1000,quantity:1},{id:'b',product_id:'p2',market_id:'m1',product_name:'未採購已發貨商品',unit_price:100,unit_cost:10,quantity:1}]}],
        procurement_checks:[{product_id:'p1',is_purchased:true},{product_id:'p2',is_purchased:false}],
        product_costs:[{product_id:'p1',cost:1000},{product_id:'p2',cost:10}],
        order_item_fulfillments:[{order_item_id:'b',shipped_at:'2026-10-01',completed_at:'2026-10-01'}],
        profit_share_settlements:[],customers:[],
      };
      tables.orders.push({id:'o2',order_number:'NS-SECOND',recipient_name:'另一收件人',phone:'',status:'confirmed',total_amount:2800,order_items:[{id:'a2',product_id:'p1',market_id:'m1',product_name:'已採購未發貨商品',unit_price:1400,unit_cost:800,quantity:2}]});
      const createClient=()=>({auth:{onAuthStateChange(){}},from:table=>{
        const query={select(){return query;},order(){return query;},then(resolve){resolve({data:structuredClone(tables[table]||[]),error:null});},async upsert(row){const found=tables[table].find(entry=>entry.product_id===row.product_id);Object.assign(found,row);return {error:null};}};
        return query;
      }});
      const createDepositManagement=()=>({bind(){},capture(){},load:async()=>{}});
      eval(source+`
        state.user={id:'admin',email:'admin@test'};state.profile={role:'owner'};state.view='admin';state.adminTab='markets';state.loading=false;
        state.orders=tables.orders;state.markets=normalizeMarkets(tables.markets);state.products=state.markets.flatMap(m=>m.products);state.procurementChecks=new Map(tables.procurement_checks.map(row=>[row.product_id,row]));
        render();window.purchaseFixture={state,render,tables};
      `);
    },{source,moduleSource});
    assert.equal(await page.locator('[data-admin-tab]').count(),6);
    assert.equal(await page.locator('[data-admin-tab="profits"]').count(),0);
    assert.equal(await page.locator('[data-admin-tab="summary"]').textContent(),'採購與分潤');
    await page.locator('[data-admin-tab="summary"]').click();
    await page.locator('[data-procurement-history="history"]').click();
    assert.equal(await page.locator('[data-procurement-product="p1"]').count(),1);
    const historyRows = await page.locator('[data-procurement-product="p1"]').evaluate(el=>[...el.closest('tr').querySelectorAll('td')].slice(1).map(td=>td.textContent));
    await page.locator('[data-procurement-history="profit"]').click();
    await page.locator('[data-profit-product="p1"]').waitFor();
    const profitRows = await page.locator('[data-profit-product="p1"]').evaluate(el=>[...el.closest('tr').querySelectorAll('td')].slice(1).map(td=>td.textContent));
    assert.deepEqual(profitRows,historyRows,'Market/product statistics match procurement history');
    assert.equal(await page.locator('[data-profit-product="p1"]').count(),1,'Same product from two orders appears as one row');
    assert.equal(await page.locator('.profit-market-list [data-profit-order]').count(),0);
    await page.screenshot({path:join(output,`market-selection-${width}.png`),fullPage:true});
    assert.equal(await page.locator('[data-profit-product="p2"]').count(),0);
    assert.match(await page.locator('.procurement-profit-content').textContent(),/採購歷史/);
    await page.locator('[data-profit-product="p1"]').check();
    assert.match(await page.locator('[data-profit-selection]').textContent(), /1 個商品・3 件/);
    assert.equal(await page.locator('[data-profit-market="m1"]').isChecked(),true);
    await page.locator('[data-profit-market="m1"]').uncheck();
    assert.equal(await page.locator('[data-profit-next]').isDisabled(),true);
    await page.locator('[data-profit-market="m1"]').check();
    assert.equal(await page.locator('[data-profit-product="p1"]').isChecked(),true);
    await page.locator('[data-profit-next]').click();
    await page.locator('[data-profit-title]').fill('保留草稿');
    await page.locator('[data-profit-confirmed]').check();
    await page.locator('[data-profit-calculate]').click();
    assert.equal(await page.locator('.profit-result-items [data-profit-product-row="p1"]').count(),1);
    assert.match(await page.locator('.profit-totals').textContent(),/商品成本NT\$ 2,600/);
    assert.match(await page.locator('.profit-totals').textContent(),/可分利潤NT\$ 1,700/);
    await page.locator('[data-profit-back="settings"]').click();
    await page.locator('[data-procurement-history="history"]').click();
    await page.locator('[data-procurement-history="profit"]').click();
    assert.equal(await page.locator('[data-profit-title]').inputValue(),'保留草稿');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Embedded workflow fits viewport');
    await page.screenshot({path:join(output,`embedded-${width}.png`),fullPage:true});
    await page.locator('[data-profit-back="select"]').click();
    await page.locator('[data-procurement-history="history"]').click();
    await page.locator('[data-procurement-product="p1"]').click();
    await page.waitForFunction(()=>document.querySelector('[data-procurement-product="p1"]')===null);
    await page.locator('[data-procurement-history="profit"]').click();
    assert.equal(await page.locator('[data-profit-product]').count(),0,'Undo purchase removes item from pending sharing');
    assert.deepEqual(errors,[]);
    console.log(`PASS ${width}px: merged navigation, purchased-only source, no shipment dependency, draft preserved, purchase undo`);
    await page.close();
  }
  console.log(`Screenshots: ${output}`);
}finally{await browser.close();}
