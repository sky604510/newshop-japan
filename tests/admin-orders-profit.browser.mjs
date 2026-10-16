import {createRequire} from 'node:module';
import {readFile,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const {chromium}=createRequire(import.meta.url)('playwright');
const source=(await readFile(new URL('../app.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'').replace(/render\(\);\r?\ninitialize\(\);\s*$/,'').replaceAll("await import('https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs')",'window.XLSX');
const moduleSource=await readFile(new URL('../profit-sharing.js',import.meta.url),'utf8');
const css=(await readFile(new URL('../styles.css',import.meta.url),'utf8')).replace(/^@import[^\r\n]+\r?\n/,'');
const output=await mkdtemp(join(tmpdir(),'newshop-admin-orders-'));
const browser=await chromium.launch({channel:'msedge',headless:true});
try {
  for(const width of [1366,390,320]) {
    const page=await browser.newPage({viewport:{width,height:900},hasTouch:width<=820});
    page.setDefaultTimeout(10000);
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('http://localhost/admin-test',r=>r.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><style>${css}</style><div id="app"></div>`}));
    await page.goto('http://localhost/admin-test');
    await page.evaluate(async({source,moduleSource})=>{
      const {createProfitSharing,allocateQuantities,allocationSummary}=await import(URL.createObjectURL(new Blob([moduleSource],{type:'text/javascript'})));
      const createDepositManagement=()=>({bind(){},capture(){},load:async()=>{},panel(){return '';},modal(){return '';}});
      const makeOrder=(id,name,day,status='confirmed')=>({id,recipient_name:name,order_number:'NS-'+id,status,created_at:`2026-10-${String(day).padStart(2,'0')}T10:00:00Z`,delivery_method:'面交取貨',total_amount:850,order_items:[{id:'i-'+id,product_id:'p',market_id:'m',product_name:'幽靈老鴨',unit_price:850,unit_cost:710,quantity:1,subtotal:850}]});
      const orders=[makeOrder('z1','Zoe',1),makeOrder('a1','Amy',1),makeOrder('w2','王小華',1),makeOrder('a2','Amy',2),makeOrder('b1','Ben',3),makeOrder('a3',' Amy ',3),makeOrder('w1','王小華',2),...Array.from({length:25},(_,i)=>makeOrder('z-'+i,'Zoe',(i%12)+1)),makeOrder('hz','Zoe',2,'completed'),makeOrder('ha1','Amy',1,'completed'),makeOrder('hw','王小華',4,'cancelled'),makeOrder('ha2','Amy',3,'cancelled')];
      const market={id:'m',name:'非常態性商品',is_active:true,products:[{id:'p',market_id:'m',name:'幽靈老鴨',price:850,cost:710,stock:99,is_active:true}]};
      const tables={orders,markets:[market],products:market.products,procurement_checks:[],product_costs:[{product_id:'p',cost:710}],profit_share_settlements:[],order_item_fulfillments:[],customers:[]};
      const createClient=()=>({auth:{onAuthStateChange(){}},from:table=>{const query={select(){return query;},order(){return query;},then(resolve){resolve({data:structuredClone(tables[table]||[]),error:null});}};return query;}});
      window.XLSX={utils:{book_new:()=>({Sheets:{}}),json_to_sheet:rows=>({rows}),book_append_sheet:(book,sheet,name)=>book.Sheets[name]=sheet},writeFile:book=>{window.exportedRows=book.Sheets['訂單'].rows;}};
      eval(source+`
        state.user={id:'admin',email:'admin@test'};state.profile={role:'owner'};state.loading=false;state.view='admin';state.adminTab='orders';
        state.orders=tables.orders;state.markets=normalizeMarkets(tables.markets);state.products=state.markets.flatMap(m=>m.products);render();
        window.orderHooks={state,tables,render,ordersByRecipient,marketSummaries,shipmentSummaries};
      `);
    },{source,moduleSource});
    const originalIds=await page.evaluate(()=>window.orderHooks.state.orders.map(o=>o.id));
    const ids=await page.locator('.order-management-table tbody tr').evaluateAll(rows=>rows.map(row=>row.id));
    assert.deepEqual(ids.slice(26,30),['order-b1','order-a3','order-a2','order-a1']);
    assert.deepEqual(ids.slice(30),['order-w1','order-w2']);
    assert.equal(ids[0],'order-z-11','The newest recipient group appears first');
    assert.equal(ids.filter(id=>id.startsWith('order-z')).length,26);
    assert.deepEqual(await page.evaluate(()=>window.orderHooks.state.orders.map(o=>o.id)),originalIds,'Display sorting must not mutate load order');
    await page.locator('[data-action="export"]').click();
    await page.waitForFunction(()=>Array.isArray(window.exportedRows));
    const exported=await page.evaluate(()=>window.exportedRows.filter(row=>row.收件人.trim()==='Amy').map(row=>row.訂單編號));
    assert.deepEqual(exported,['NS-a3','NS-ha2','NS-a2','NS-a1','NS-ha1']);
    await page.evaluate(()=>{
      const {state,render}=window.orderHooks;
      state.orders.push({...state.orders.find(order=>order.id==='a1'),id:'new-amy',order_number:'NS-NEW-AMY',created_at:'2026-10-16T12:00:00Z'});
      render();
    });
    assert.deepEqual(await page.locator('.order-management-table tbody tr').evaluateAll(rows=>rows.slice(0,4).map(row=>row.id)),['order-new-amy','order-a3','order-a2','order-a1'],'A newly received order brings its earlier same-name orders to the top');
    assert.equal(await page.locator('.order-zoom-controls, #order-table-zoom').count(),0,'No slider or zoom controls');
    if(width<=820) {
      const table=page.locator('.order-management-table');
      const originalWidth=await table.evaluate(el=>el.getBoundingClientRect().width);
      const session=await page.context().newCDPSession(page);
      async function pinch(from,to) {
        await page.evaluate(()=>{
          const content=document.querySelector('.admin-content'),table=document.querySelector('.order-management-table');
          content.scrollTop+=table.getBoundingClientRect().top-content.getBoundingClientRect().top-20;
        });
        const center=await table.evaluate(el=>{
          const wrap=el.closest('.order-table-wrap').getBoundingClientRect(),content=el.closest('.admin-content').getBoundingClientRect();
          return {x:wrap.left+wrap.width/2,y:Math.min(content.bottom-35,Math.max(content.top+60,el.getBoundingClientRect().top+60))};
        });
        const touches=distance=>[{x:center.x-distance/2,y:center.y,id:1},{x:center.x+distance/2,y:center.y,id:2}];
        await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:touches(from)});
        for(let i=1;i<=5;i++)await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:touches(from+(to-from)*i/5)});
        await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      }
      await pinch(220,8);
      const fit=await table.evaluate(el=>{
        const wrap=el.closest('.order-table-wrap'),style=getComputedStyle(wrap),rect=wrap.getBoundingClientRect(),tableRect=el.getBoundingClientRect();
        return {left:tableRect.left,right:tableRect.right,limit:rect.left+wrap.clientLeft+wrap.clientWidth-parseFloat(style.paddingRight),overflow:wrap.scrollWidth-wrap.clientWidth};
      });
      assert.ok(fit.right<=fit.limit+1,'Pinch inward fits all seven columns');
      assert.ok(fit.overflow<=1,'Fit mode has no horizontal overflow');
      assert.equal(await page.evaluate(()=>visualViewport.scale),1,'Pinch scales only table, not browser page');
      await page.screenshot({path:join(output,'orders-pinch-fit-'+width+'.png')});
      await pinch(8,220);
      assert.ok(Math.abs(await table.evaluate(el=>el.getBoundingClientRect().width)-originalWidth)<1,'Pinch outward capped at original size');
      await pinch(220,140);
      const middleWidth=await table.evaluate(el=>el.getBoundingClientRect().width);
      assert.ok(middleWidth<originalWidth&&middleWidth>fit.right-fit.left,'Pinch supports intermediate magnification');
      await page.evaluate(()=>window.orderHooks.render());
      assert.ok(Math.abs(await table.evaluate(el=>el.getBoundingClientRect().width)-middleWidth)<1,'Zoom retained across rerenders');
      await pinch(8,220);
      await page.waitForTimeout(650);
      const box=await page.locator('.admin-content').boundingBox();
      const scrollBefore=await page.locator('.admin-content').evaluate(el=>el.scrollTop);
      await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:width/2,y:box.y+box.height-35,id:1}]});
      for(let i=1;i<=5;i++)await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:width/2,y:box.y+box.height-35-i*16,id:1}]});
      await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      await page.waitForTimeout(250);
      assert.ok(await page.locator('.admin-content').evaluate(el=>el.scrollTop)>scrollBefore,'Single finger still scrolls the orders');
      await session.detach();
      await page.evaluate(()=>{window.orderHooks.state.adminMenuCollapsed=false;window.orderHooks.render();document.querySelector('.admin-content').scrollTop=0;});
      const colors=await page.evaluate(()=>({toolbar:getComputedStyle(document.querySelector('.admin-mobile-toolbar')).backgroundColor,active:getComputedStyle(document.querySelector('.admin-tabs button.active')).backgroundColor,text:getComputedStyle(document.querySelector('.admin-mobile-toolbar strong')).color}));
      assert.equal(colors.toolbar,colors.active);assert.equal(colors.text,'rgb(255, 255, 255)');
    }
    const before=await page.locator('.admin-tabs').boundingBox();
    await page.locator('.admin-content').evaluate(el=>el.scrollTop=900);
    assert.ok(await page.locator('.admin-content').evaluate(el=>el.scrollTop>0));
    const after=await page.locator('.admin-tabs').boundingBox();
    assert.ok(Math.abs(before.y-after.y)<1,'Tab row stays in its own layout row');
    const region=await page.locator('.admin-content').boundingBox();
    assert.ok(region.y>=after.y+after.height+9,'Scrolling content is clipped below navigation');
    assert.equal(await page.evaluate(()=>scrollY),0,'Only the content region scrolls');
    await page.evaluate(()=>window.orderHooks.render());
    assert.equal(await page.locator('.admin-content').evaluate(el=>el.scrollTop),900,'Rerender retains the current scroll position');
    await page.screenshot({path:join(output,`orders-scrolled-${width}.png`)});
    if(width<=820) {
      await page.locator('.admin-content').dispatchEvent('wheel',{deltaY:100});
      await page.locator('.admin-content').evaluate(el=>el.scrollTop+=100);
      await page.waitForFunction(()=>document.body.classList.contains('admin-menu-collapsed'));
      assert.ok(await page.locator('.nav').isHidden());
      assert.ok(await page.locator('.admin-tabs').isHidden());
      assert.equal(await page.locator('[data-admin-menu-toggle]').getAttribute('aria-expanded'),'false');
      const compact=await page.locator('.admin-content').boundingBox();
      assert.ok(compact.y<100,'Collapsed navigation frees the top of the phone screen');
      await page.screenshot({path:join(output,`compact-${width}.png`)});
      await page.locator('[data-admin-menu-toggle]').click();
      assert.ok(await page.locator('.admin-tabs').isVisible());
      assert.ok(await page.locator('.nav').isVisible());
      await page.screenshot({path:join(output,`expanded-${width}.png`)});
      await page.locator('[data-admin-tab="orders"]').click();
      assert.equal(await page.locator('[data-admin-menu-toggle]').getAttribute('aria-expanded'),'false','Choosing another tab closes the expanded menu');
      await page.setViewportSize({width:1366,height:900});
      assert.ok(await page.locator('.nav').isVisible());
      assert.ok(await page.locator('.admin-tabs').isVisible());
      await page.setViewportSize({width,height:900});
    }
    await page.locator('[data-order-history="history"]').click();
    assert.deepEqual(await page.locator('.order-management-table tbody tr').evaluateAll(rows=>rows.map(row=>row.id)),['order-hw','order-ha2','order-ha1','order-hz']);
    await page.locator('[data-order-history="current"]').click();
    await page.evaluate(()=>{
      const {state,tables,render}=window.orderHooks;
      const order={id:'duck-order',order_number:'NS-DUCK',recipient_name:'王小華',phone:'',status:'confirmed',delivery_method:'面交取貨',deposit_amount:850,deposit_deduction:850,total_amount:1700,created_at:'2026-10-15T10:00:00Z',order_items:[{id:'duck',product_id:'p',market_id:'m',product_name:'幽靈老鴨',unit_price:850,unit_cost:710,quantity:3,subtotal:2550}]};
      state.orders=[order];tables.orders=[order];state.adminTab='summary';state.procurementHistory=false;
      state.procurementChecks.set('p',{is_purchased:false,cost_allocations:{duck:[3,0]}});render();
    });
    const profit=await page.locator('[data-procurement-product="p"]').evaluate(el=>el.closest('tr').querySelector('td.profit').textContent);
    assert.equal(profit,'NT$ 420');
    assert.equal((await page.locator('.admin-content').textContent()).includes('已扣商品內扣'),false);
    assert.match(await page.locator('.procurement-subtotal').textContent(),/NT\$ 2,130/);
    assert.match(await page.locator('.procurement-subtotal').textContent(),/NT\$ 2,550/);
    const summary=await page.evaluate(()=>window.orderHooks.marketSummaries()[0].rows[0]);
    assert.equal(summary.revenue,2550);assert.equal(summary.profit,420);
    const shipment=await page.evaluate(()=>window.orderHooks.shipmentSummaries('pending')[0]);
    assert.equal(shipment.amount,1700,'Unpaid balance still applies the deposit');assert.equal(shipment.profit,420);
    await page.screenshot({path:join(output,`procurement-profit-${width}.png`)});
    await page.evaluate(()=>{window.orderHooks.state.view='shop';window.orderHooks.render();});
    assert.equal(await page.evaluate(()=>document.body.classList.contains('admin-workspace')),false);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert.deepEqual(errors,[]);
    console.log(`PASS ${width}px: current/history name grouping, newest first, Excel order, separate scrolling, scroll retention, deposit profit 420, balance 1700`);
    await page.close();
  }
  console.log('Screenshots: '+output);
}finally{await browser.close();}
