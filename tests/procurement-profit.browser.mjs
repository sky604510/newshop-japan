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
      const {createProfitSharing,allocateQuantities,allocationSummary}=await import(URL.createObjectURL(new Blob([moduleSource],{type:'text/javascript'})));
      const tables={
        markets:[{id:'m1',name:'測試賣場',is_active:true,products:[{id:'p1',market_id:'m1',name:'已採購未發貨商品',price:1500,stock:3,is_active:true},{id:'p2',market_id:'m1',name:'未採購已發貨商品',price:100,stock:3,is_active:true}]}],
        orders:[{id:'o1',order_number:'NS-PURCHASE',recipient_name:'測試收件人',status:'confirmed',total_amount:1600,order_items:[{id:'a',product_id:'p1',market_id:'m1',product_name:'已採購未發貨商品',unit_price:1500,unit_cost:1000,quantity:1},{id:'b',product_id:'p2',market_id:'m1',product_name:'未採購已發貨商品',unit_price:100,unit_cost:10,quantity:1}]}],
        procurement_checks:[{product_id:'p1',is_purchased:true,cost_allocations:{a:[1,0],a2:[1,1]}},{product_id:'p2',is_purchased:false}],
        product_costs:[{product_id:'p1',cost:1000},{product_id:'p2',cost:10}],
        order_item_fulfillments:[{order_item_id:'a',shipped_at:'2026-10-01',completed_at:'2026-10-02',reconciled_at:'2026-10-02'},{order_item_id:'a2',shipped_at:'2026-10-01',completed_at:'2026-10-02',reconciled_at:'2026-10-02'},{order_item_id:'b',shipped_at:'2026-10-01'}],
        profit_share_settlements:[],customers:[],
      };
      tables.orders.push({id:'o2',order_number:'NS-SECOND',recipient_name:'另一收件人',phone:'',status:'confirmed',total_amount:2800,order_items:[{id:'a2',product_id:'p1',market_id:'m1',product_name:'已採購未發貨商品',unit_price:1400,unit_cost:800,quantity:2}]});
      Object.assign(tables.orders[0],{deposit_amount:500,deposit_deduction:500,total_amount:1100});
      const createClient=()=>({auth:{onAuthStateChange(){}},rpc:async(name,args)=>{
        if(name !== 'admin_set_procurement_cost_people') throw Error('Unexpected RPC');
        args.p_records.forEach(row=>Object.assign(tables.procurement_checks.find(entry=>entry.product_id===row.product_id),row)); return {error:null};
      },from:table=>{
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
    assert.equal(await page.locator('[data-admin-tab]').count(),7);
    assert.equal(await page.locator('[data-admin-tab="profits"]').count(),1);
    assert.equal(await page.locator('[data-admin-tab="summary"]').textContent(),'採購清單');
    await page.locator('[data-admin-tab="summary"]').click();
    await page.locator('[data-admin-tab="summary"]').click();
    await page.locator('[data-admin-tab="summary"]').click();
    await page.locator('[data-procurement-history="history"]').click();
    assert.equal(await page.locator('[data-procurement-product="p1"]').count(),1);
    assert.equal(await page.locator('[data-cost-product="p1"]').inputValue(),'shared');
    await page.locator('[data-cost-market="m1"]').selectOption('1');
    await page.waitForFunction(()=>window.purchaseFixture.state.procurementChecks.get('p2').cost_allocations?.b?.[1]===1);
    assert.deepEqual(await page.evaluate(()=>window.purchaseFixture.state.procurementChecks.get('p1').cost_allocations),{a:[0,1],a2:[0,2]});
    await page.locator('[data-cost-product="p1"]').selectOption('1');
    await page.waitForFunction(()=>document.querySelector('[data-cost-product="p1"]')?.value==='1' && !document.querySelector('[data-cost-product="p1"]').disabled);
    await page.locator('[data-cost-product="p1"]').selectOption('shared');
    await page.locator('[data-cost-hao="p1"]').fill('2');
    assert.equal(await page.locator('[data-cost-split="p1"] [data-cost-ying]').textContent(),'盈 1 件');
    await page.locator('[data-cost-save="p1"]').click();
    await page.waitForFunction(()=>window.purchaseFixture.state.procurementChecks.get('p1').cost_allocations.a2[0]===1);
    await page.locator('[data-cost-product="p1"]').waitFor();
    await page.screenshot({path:join(output,`procurement-shared-${width}.png`),fullPage:true});
    const historyRows = await page.locator('[data-procurement-product="p1"]').evaluate(el=>[...el.closest('tr').querySelectorAll('td')].slice(1).filter((td,index)=>index!==5).map(td=>td.textContent));
    await page.locator('[data-admin-tab="profits"]').click();
    await page.locator('[data-profit-product="p1"]').waitFor();
    const profitRows = await page.locator('[data-profit-product="p1"]').evaluate(el=>[...el.closest('tr').querySelectorAll('td')].slice(1).map(td=>td.textContent));
    assert.deepEqual(profitRows,historyRows,'Market/product statistics match procurement history');
    assert.doesNotMatch(profitRows.join(''),/已扣商品內扣/);
    assert.match(profitRows.at(-1),/NT\$ 1,700/,'Deposit offsets do not reduce merchandise profit');
    assert.equal(await page.locator('[data-profit-product="p1"]').count(),1,'Same product from two orders appears as one row');
    assert.equal(await page.locator('.profit-market-list [data-profit-order]').count(),0);
    await page.screenshot({path:join(output,`market-selection-${width}.png`),fullPage:true});
    assert.equal(await page.locator('[data-profit-product="p2"]').count(),0);
    assert.match(await page.locator('.admin-page').textContent(),/只從發貨清單「已完成」/);
    assert.equal(await page.locator('[data-procurement-history]').count(),0);
    await page.locator('[data-profit-product="p1"]').check();
    assert.match(await page.locator('[data-profit-selection]').textContent(), /1 個商品・3 件/);
    assert.match(await page.locator('[data-profit-selection]').textContent(), /NT\$ 4,300/,'Selection total includes already received deposits');
    assert.equal(await page.locator('[data-profit-market="m1"]').isChecked(),true);
    await page.locator('[data-profit-market="m1"]').uncheck();
    assert.equal(await page.locator('[data-profit-next]').isDisabled(),true);
    await page.locator('[data-profit-market="m1"]').check();
    assert.equal(await page.locator('[data-profit-product="p1"]').isChecked(),true);
    await page.locator('[data-profit-next]').click();
    assert.equal(await page.locator('[data-profit-received]').inputValue(),'4300','Default settlement receipts do not subtract deposits');
    await page.locator('[data-profit-title]').fill('保留草稿');
    await page.locator('[data-profit-confirmed]').check();
    await page.locator('[data-profit-calculate]').click();
    assert.equal(await page.locator('.profit-result-items [data-profit-product-row="p1"]').count(),1);
    assert.match(await page.locator('.profit-totals').textContent(),/商品成本NT\$ 2,600/);
    assert.match(await page.locator('.profit-totals').textContent(),/可分利潤NT\$ 1,700/);
    await page.locator('[data-profit-back="settings"]').click();
    await page.locator('[data-admin-tab="summary"]').click();
    await page.locator('[data-procurement-history="history"]').click();
    await page.locator('[data-admin-tab="profits"]').click();
    assert.equal(await page.locator('[data-profit-title]').inputValue(),'保留草稿');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Embedded workflow fits viewport');
    await page.screenshot({path:join(output,`embedded-${width}.png`),fullPage:true});
    await page.locator('[data-profit-back="select"]').click();
    await page.evaluate(()=>{
      window.purchaseFixture.state.orders.forEach(order=>order.order_items.filter(item=>item.product_id==='p1').forEach(item=>{item.unit_cost=0;item.unit_cost_overridden=true;}));
      window.purchaseFixture.render();
    });
    await page.locator('[data-profit-next]').click();
    await page.locator('[data-profit-zero-product="p1"]').check();
    await page.locator('[data-profit-zero-confirm]').click();
    assert.equal(await page.locator('[data-profit-product-row="p1"]').count(),1,'Zero-cost dialog works inside actual app');
    await page.locator('[data-profit-back="select"]').click();
    await page.locator('[data-admin-tab="summary"]').click();
    await page.locator('[data-procurement-history="history"]').click();
    await page.locator('[data-procurement-product="p1"]').click();
    await page.waitForFunction(()=>document.querySelector('[data-procurement-product="p1"]')===null);
    await page.locator('[data-admin-tab="profits"]').click();
    assert.equal(await page.locator('[data-profit-product]').count(),1,'Undo purchase does not affect completed shipment source');
    await page.evaluate(()=>window.purchaseFixture.tables.order_item_fulfillments.forEach(item=>{item.completed_at=null;item.reconciled_at=null;}));
    await page.locator('[data-admin-tab="summary"]').click();
    await page.locator('[data-admin-tab="profits"]').click();
    assert.equal(await page.locator('[data-profit-product]').count(),0,'Undo shipment completion removes item from pending sharing');
    assert.deepEqual(errors,[]);
    console.log(`PASS ${width}px: independent navigation, completed-only source, market grouping, draft preserved, purchase independence, completion undo`);
    await page.close();
  }
  console.log(`Screenshots: ${output}`);
}finally{await browser.close();}
