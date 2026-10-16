import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const {chromium}=createRequire(import.meta.url)('playwright');
const source=(await readFile(new URL('../app.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'').replace(/render\(\);\r?\ninitialize\(\);\s*$/,'');
const browser=await chromium.launch({channel:'msedge',headless:true});
try {
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('http://localhost/performance-test',r=>r.fulfill({contentType:'text/html',body:'<div id="app"></div>'}));
 await page.goto('http://localhost/performance-test');
 await page.evaluate(source=>{
  let authListener;window.calls=[];window.rpcError=null;window.readError=null;
  const order={id:'o1',order_number:'NS-1',recipient_name:'Amy',phone:'',delivery_method:'面交取貨',status:'confirmed',total_amount:200,created_at:'2026-10-01',order_items:[{id:'i1',product_id:'p1',market_id:'m1',product_name:'商品',unit_price:200,unit_cost:100,quantity:1,subtotal:200}]};
  const tables={markets:[{id:'m1',name:'測試賣場',is_active:true,products:[{id:'p1',name:'商品',market_id:'m1',stock:20,price:200,is_active:true}]}],orders:[order,{...structuredClone(order),id:'o2',created_at:'2026-10-02',order_items:[{...structuredClone(order.order_items[0]),id:'i2'}]}],profiles:{id:'admin',role:'owner'},product_costs:[{product_id:'p1',cost:100}],order_item_fulfillments:[{order_item_id:'i1',purchase_confirmed:true,shipped_at:null},{order_item_id:'other',shipped_at:'2026-10-01'}]};
  let release;const gate=new Promise(resolve=>release=resolve);window.releaseOrders=release;let blockOrders=true;
  const createClient=()=>({auth:{onAuthStateChange(callback){authListener=callback;},async getSession(){const session={user:{id:'admin'}};authListener('INITIAL_SESSION',session);return {data:{session}};}},from(table){
    let filter=null;const query={select(){return query;},order(){return query;},eq(key,value){filter={key,value};return query;},in(key,value){filter={key,value};return query;},single(){return query;},async then(resolve,reject){try{
      window.calls.push({table,filter});if(table==='orders'&&blockOrders)await gate;
      if(table===window.readError) return resolve({error:{message:'network unavailable'}});
      let data=structuredClone(tables[table]||[]);
      if(filter && Array.isArray(data))data=data.filter(row=>Array.isArray(filter.value)?filter.value.includes(row[filter.key]):row[filter.key]===filter.value);
      resolve({data,error:null});
    }catch(e){reject(e);}}};return query;
  },async rpc(name,args){window.calls.push({rpc:name});if(window.rpcError)return {error:{message:window.rpcError}};
    if(name==='admin_ship_order_items')tables.order_item_fulfillments[0].shipped_at='2026-10-16';
    else {const row=tables.orders.find(o=>o.id===args.p_order_id);row.recipient_name=args.p_recipient_name;row.order_items[0].quantity=args.p_items[0].quantity;}
    return {error:null};}});
  const createProfitSharing=()=>({bind(){},capture(){},modal(){return '';},panel(){return '';},load:async()=>{window.calls.push({table:'profit_history'});}});
  const createDepositManagement=()=>({bind(){},modal(){return '';},panel(){return '';},load:async()=>{window.calls.push({table:'refund_history'});}});
  eval(source+`
    window.hooks={state,render,initialize,loadMarkets,openOrderEditor,saveOrderEditor,shipSelectedItems,fetchWithTimeout};
    window.finishOrders=()=>{blockOrders=false;release();};
    window.initDone=initialize();
  `);
 },source);
 await page.waitForSelector('.market-card');
 assert.equal(await page.evaluate(()=>window.hooks.state.loading),false,'Catalog renders while private order query is pending');
 await page.waitForFunction(()=>window.calls.some(c=>c.table==='orders'));
 await page.evaluate(()=>window.finishOrders());await page.evaluate(()=>window.initDone);
 let calls=await page.evaluate(()=>window.calls);
 assert.equal(calls.filter(c=>c.table==='markets').length,1,'Initial auth event does not duplicate catalog fetch');
 assert.equal(calls.filter(c=>c.table==='orders').length,1,'Private data loaded once');
 assert.ok(!calls.some(c=>['profit_history','refund_history'].includes(c.table)),'History loaded only when opening its page');
 // Deduplicate concurrent catalog requests.
 await page.evaluate(async()=>{window.calls=[];await Promise.all([window.hooks.loadMarkets(),window.hooks.loadMarkets()]);});
 assert.equal((await page.evaluate(()=>window.calls)).length,1);
 async function save(quantity){
   await page.evaluate(()=>{const h=window.hooks;h.state.view='admin';h.state.adminTab='orders';h.openOrderEditor('o1');window.calls=[];});
   await page.locator('#order-recipient').fill('Amy 改名');
   if(quantity)await page.locator('[data-order-draft-quantity]').fill(String(quantity));
   await page.evaluate(()=>window.hooks.saveOrderEditor());return page.evaluate(()=>window.calls);
 }
 calls=await save();
 assert.deepEqual(calls.filter(c=>c.table).map(c=>({table:c.table,filter:c.filter})),[{table:'orders',filter:{key:'id',value:'o1'}}],'Contact edit refreshes only saved order');
 assert.equal(await page.evaluate(()=>window.hooks.state.orders.length),2,'Other orders retained');
 assert.equal(await page.evaluate(()=>window.hooks.state.orders[0].id),'o2','Newest order ordering retained');
 calls=await save(2);
 assert.ok(calls.some(c=>c.table==='markets')&&calls.some(c=>c.table==='product_costs'),'Quantity change refreshes inventory and costs');
 await page.evaluate(()=>{window.readError='orders';});await save();
 assert.match(await page.locator('.toast').textContent(),/已儲存.*更新失敗/);
 assert.equal(await page.evaluate(()=>window.hooks.state.modal),null,'Successful save cannot be resubmitted after refresh failure');
 await page.evaluate(()=>{window.readError=null;const h=window.hooks;h.state.adminTab='shipments';h.state.fulfillmentChecks=new Map([['other',{order_item_id:'other',shipped_at:'2026-10-01'}]]);h.state.shipmentSelection=new Set(['i1']);h.render();window.calls=[];window.confirm=()=>true;});
 await page.evaluate(()=>window.hooks.shipSelectedItems());
 calls=await page.evaluate(()=>window.calls);
 assert.deepEqual(calls.find(c=>c.table==='order_item_fulfillments').filter,{key:'order_item_id',value:['i1']});
 assert.equal(await page.evaluate(()=>window.hooks.state.fulfillmentChecks.size),2,'Unrelated shipment state retained');
 assert.ok(await page.evaluate(()=>Boolean(window.hooks.state.fulfillmentChecks.get('i1').shipped_at)));
 // A failed read after a committed shipment must never be reported as a successful refresh.
 await page.evaluate(async()=>{const h=window.hooks;h.state.fulfillmentChecks.get('i1').shipped_at=null;h.state.shipmentSelection.add('i1');window.readError='order_item_fulfillments';await h.shipSelectedItems();});
 assert.match(await page.locator('.toast').textContent(),/發貨已儲存.*載入失敗/);
 assert.equal(await page.evaluate(()=>window.hooks.state.shipmentBusy),false);
 // Use a short fake deadline to exercise actual fetch cancellation without waiting 30 seconds.
 const timeout=await page.evaluate(async()=>{
   const originalFetch=window.fetch,originalTimeout=window.setTimeout;
   window.setTimeout=(fn,ms,...args)=>originalTimeout(fn,ms===30000?15:ms,...args);
   window.fetch=(_input,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
   try{await window.hooks.fetchWithTimeout('/stalled');return 'failed';}catch(e){return e.name;}finally{window.fetch=originalFetch;window.setTimeout=originalTimeout;}
 });assert.equal(timeout,'TimeoutError');
 assert.deepEqual(errors,[]);console.log('PASS: startup deduplication, public rendering, scoped save/stock refresh, shipment refresh, error recovery and HTTP deadline');
}finally{await browser.close();}
