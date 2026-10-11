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
const output=await mkdtemp(join(tmpdir(),'newshop-cover-'));
try {
  for(const width of [1366,390,320]) {
    const page=await browser.newPage({viewport:{width,height:900}});
    page.setDefaultTimeout(10000);
    const errors=[]; page.on('pageerror',e=>errors.push(e.message));
    await page.route('http://localhost/cover-test',r=>r.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><style>${css}</style><div id="app"></div>`}));
    await page.goto('http://localhost/cover-test');
    await page.evaluate(async({source,moduleSource})=>{
      const {allocateQuantities,allocationSummary}=await import(URL.createObjectURL(new Blob([moduleSource],{type:'text/javascript'})));
      const stub=()=>({bind(){},load:async()=>{},capture(){},panel(){return '';},modal(){return '';}});
      const createProfitSharing=stub,createDepositManagement=stub;
      const artwork='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900"><rect width="600" height="300" fill="#ff99b9"/><rect y="300" width="600" height="300" fill="#fff0a8"/><rect y="600" width="600" height="300" fill="#a7d9bf"/><text x="200" y="140" font-size="60">TOP</text><text x="180" y="450" font-size="60">MIDDLE</text><text x="170" y="780" font-size="60">BOTTOM</text></svg>');
      const tables={markets:[{id:'m',name:'封面調整測試',description:'保留原圖',image_url:artwork,cover_layout:null,is_active:true,closes_at:'2026-11-11',products:[{id:'p',market_id:'m',name:'測試商品',price:1550,cost:1330,stock:3,is_active:true}]}],orders:[{id:'o',status:'confirmed',order_items:[{id:'i',product_id:'p',quantity:3,unit_cost:1330,unit_price:1550}]}],product_costs:[{product_id:'p',cost:1330}],procurement_checks:[],customers:[],order_item_fulfillments:[]};
      tables.products=tables.markets.flatMap(m=>m.products);
      const createClient=()=>({auth:{onAuthStateChange(){}},rpc:async()=>({error:null}),from:table=>{
        let filter,update,fields;
        const query={select(value){fields=value;return query;},order(){return query;},eq(key,value){filter=[key,value];return query;},update(value){update=value;return query;},single(){return query;},then(resolve){
          const rows=tables[table]||[];
          if(table==='markets' && window.coverMissing && fields?.includes('cover_layout')) return resolve({error:{message:'column markets.cover_layout does not exist'}});
          if(update) {Object.assign(rows.find(row=>!filter||row[filter[0]]===filter[1]),update);if(table==='markets')window.lastMarketPayload=update;}
          resolve({data:filter?rows.find(row=>row[filter[0]]===filter[1]):structuredClone(rows),error:null});
        }};return query;
      }});
      eval(source+`
        state.user={id:'admin'};state.profile={role:'owner'};state.loading=false;state.view='admin';
        state.markets=normalizeMarkets(tables.markets);state.products=state.markets.flatMap(m=>m.products);state.orders=tables.orders;
        render();window.coverHooks={state,render,tables,loadMarkets,openMarketEditor,normalizeCoverLayout,marketCard};
      `);
    },{source,moduleSource});
    await page.locator('[data-edit-market="m"]').click();
    await page.locator('[data-adjust-market-cover]').click();
    assert.ok(await page.locator('[data-cover-adjustment]').isVisible());
    await page.locator('#market-name').fill('名稱不會因調整遺失');
    await page.locator('[data-cover-zoom]').fill('1.75');
    await page.locator('[data-cover-y]').fill('80');
    const preview=await page.locator('[data-cover-preview]').getAttribute('style');
    assert.match(preview,/--cover-zoom:1.75/);
    assert.match(preview,/--cover-y:80%/);
    assert.equal(await page.locator('[data-cover-zoom-value]').textContent(),'175%');
    assert.equal(await page.locator('[data-cover-y-value]').textContent(),'80%');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:join(output,`editor-${width}.png`),fullPage:true});
    await page.locator('[data-adjust-market-cover]').click();
    await page.locator('[data-adjust-market-cover]').click();
    assert.equal(await page.locator('[data-cover-zoom]').inputValue(),'1.75');
    assert.equal(await page.locator('#market-name').inputValue(),'名稱不會因調整遺失');
    await page.locator('[data-action="save-market"]').click();
    await page.waitForFunction(()=>window.coverHooks.state.modal===null);
    assert.deepEqual(await page.evaluate(()=>window.coverHooks.tables.markets[0].cover_layout),{zoom:1.75,y:80});
    assert.equal(await page.evaluate(()=>window.lastMarketPayload.name),'名稱不會因調整遺失');
    await page.evaluate(()=>{window.coverHooks.state.view='shop';window.coverHooks.render();});
    assert.equal(await page.locator('.market-cover img').getAttribute('style'),preview);
    await page.locator('.market-card').evaluate(el=>Promise.all(el.getAnimations().map(animation=>animation.finished)));
    const geometry=await page.locator('.market-cover').evaluate(el=>({ratio:el.clientWidth/el.clientHeight,height:el.clientHeight,imageHeight:el.querySelector('img').clientHeight,transform:getComputedStyle(el.querySelector('img')).transform}));
    assert.ok(Math.abs(geometry.ratio-(width<=600?1.45:1.92))<0.02);
    assert.ok(Math.abs(geometry.height-geometry.imageHeight)<2,'Actual cover image uses the same frame size as preview');
    await page.screenshot({path:join(output,`storefront-${width}.png`),fullPage:true});
    await page.evaluate(()=>{window.coverHooks.state.view='admin';window.coverHooks.state.adminTab='markets';window.coverHooks.render();});
    await page.locator('[data-edit-market="m"]').click();
    await page.locator('[data-adjust-market-cover]').click();
    assert.equal(await page.locator('[data-cover-y]').inputValue(),'80');
    await page.locator('[data-cover-reset]').click();
    assert.equal(await page.locator('[data-cover-zoom]').inputValue(),'1');
    assert.equal(await page.locator('[data-cover-y]').inputValue(),'50');
    await page.locator('#market-image').setInputFiles({name:'new-cover.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64')});
    assert.deepEqual(await page.evaluate(()=>window.coverHooks.state.marketDraft.cover_layout),{zoom:1,y:50});
    assert.equal(await page.locator('[data-cover-preview]').count(),1);
    await page.locator('[data-clear-market-image]').click();
    assert.ok(await page.locator('[data-adjust-market-cover]').isDisabled());
    assert.ok(await page.locator('[data-cover-adjustment]').isHidden());
    assert.equal(await page.locator('[data-cover-preview]').count(),0);
    await page.locator('[data-action="cancel-market"]').click();
    await page.evaluate(()=>{window.coverHooks.state.adminTab='summary';window.coverHooks.render();});
    assert.equal(await page.locator('.procurement-subtotal td').nth(5).textContent(),'NT$ 3,990');
    assert.equal(await page.locator('.procurement-subtotal td').nth(7).textContent(),'NT$ 4,650');
    await page.evaluate(async()=>{window.coverMissing=true;await window.coverHooks.loadMarkets();window.coverHooks.state.adminTab='markets';window.coverHooks.render();});
    await page.locator('[data-edit-market="m"]').click();
    assert.ok(await page.locator('[data-adjust-market-cover]').isDisabled());
    assert.match(await page.locator('.setup-notice').last().textContent(),/market_cover_layout_upgrade.sql/);
    assert.deepEqual(errors,[]);
    console.log(`PASS ${width}px: zoom, position, preview, draft preservation, save/reopen, storefront framing, reset, delete, subtotals, missing migration`);
    await page.close();
  }
  console.log(`Screenshots: ${output}`);
} finally {await browser.close();}
