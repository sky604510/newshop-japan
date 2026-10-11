import { createRequire } from 'node:module';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const { chromium } = createRequire(import.meta.url)('playwright');
const source = (await readFile(new URL('../app.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '').replace(/render\(\);\r?\ninitialize\(\);\s*$/, '');
const css = (await readFile(new URL('../styles.css', import.meta.url), 'utf8')).replace(/^@import[^\r\n]+\r?\n/, '') + await readFile(new URL('../design.css', import.meta.url), 'utf8');
const output = await mkdtemp(join(tmpdir(), 'newshop-design-'));
const browser = await chromium.launch({ channel:'msedge', headless:true });
try {
  for (const width of [1440, 820, 390, 320]) {
    const page = await browser.newPage({viewport:{width,height:900}});
    const errors = []; page.on('pageerror',error=>errors.push(error.message));
    await page.route('http://localhost/design-test',route=>route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><style>${css}</style><div id="app"></div>`}));
    await page.route('http://localhost/assets/**', async route=>route.fulfill({contentType:'image/png',body:await readFile(new URL('../assets/logo_v2.png',import.meta.url))}));
    await page.goto('http://localhost/design-test');
    await page.evaluate(appSource=>{
      const stub=()=>({bind(){},capture(){},panel(){return '';},modal(){return '';}});
      const createProfitSharing=stub,createDepositManagement=stub;
      const createClient=()=>({auth:{onAuthStateChange(){}}});
      eval(appSource+`
        state.loading=false;
        const artwork=(color,label)=>'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400"><rect width="600" height="400" fill="'+color+'"/><circle cx="300" cy="200" r="110" fill="#fffaf6"/><text x="300" y="210" text-anchor="middle" font-family="serif" font-size="35" fill="#704253">'+label+'</text></svg>');
        state.markets=[{id:'m1',name:'東京連線・日常的小小收藏',description:'角色周邊與日系選物，每一件都是心動的理由。',is_active:true,image_url:artwork('#edd7d6','TOKYO SELECT'),products:[{id:'p1',market_id:'m1',name:'限定收藏吊飾',price:480,stock:10,is_active:true,image_url:artwork('#edd7d6','SELECT')}]},{id:'m2',name:'LIVE TOUR・把那一刻留下',description:'演唱會官方周邊，收藏屬於你的現場記憶。',is_active:true,image_url:artwork('#d9d9e2','LIVE COLLECTION'),products:[{id:'p2',market_id:'m2',name:'紀念毛巾',price:850,stock:8,is_active:true}]}];
        state.products=state.markets.flatMap(m=>m.products);render();
        window.designHooks={state,render};
      `);
    },source);
    assert.equal(await page.locator('h1').count(),1);
    assert.equal(await page.locator('.market-card').count(),2);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No horizontal overflow');
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('.skip-link').evaluate(el=>el===document.activeElement),true);
    await page.locator('h1').click();
    await page.waitForFunction(()=>[...document.querySelectorAll('.reveal')].every(el=>getComputedStyle(el).opacity==='1'));
    await page.screenshot({path:join(output,`store-${width}.png`),fullPage:true});
    await page.locator('.market-cover').first().click();
    assert.equal(await page.locator('.market-detail').count(),1);
    await page.locator('.modal-backdrop').evaluate(async el=>{
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      await Promise.all(el.getAnimations({subtree:true}).map(animation=>animation.finished.catch(()=>{})));
    });
    assert.ok(await page.locator('.market-detail').evaluate(el=>el.getBoundingClientRect().right<=innerWidth),'Market modal fits viewport');
    if(width<=820) assert.ok(await page.evaluate(()=>document.querySelector('.detail-media').getBoundingClientRect().bottom<=document.querySelector('.detail-copy').getBoundingClientRect().top+1),'Mobile cover and products stack vertically');
    await page.screenshot({path:join(output,`market-${width}.png`)});
    await page.locator('[data-batch-delta="1"]').click();
    assert.equal(await page.locator('[data-batch-total-count]').textContent(),'1');
    await page.locator('[data-action="add-selected-item"]').click();
    assert.equal(await page.evaluate(()=>window.designHooks.state.cart[0].qty),1);
    await page.emulateMedia({reducedMotion:'reduce'});
    assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).scrollBehavior),'auto');
    assert.deepEqual(errors,[]);
    console.log(`PASS ${width}px: storefront, focus, market modal, reduced motion, overflow`);
    await page.close();
  }
  console.log(`Screenshots: ${output}`);
} finally {await browser.close();}
