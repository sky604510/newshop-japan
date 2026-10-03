import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateProfitShare, completedProfitItems, createProfitSharing, equalProfitRatios, procurementProfitGroups } from '../profit-sharing.js';

const parties = [{ name: '我', ratio: 50 }, { name: '老婆', ratio: 50 }];
const item = { id: 'a', quantity: 1, unit_price: 1500, unit_cost: 1000 };
const settings = { parties, collector: 1, received: 1500, receivedConfirmed: true, payers: { a: 0 }, expenses: [{ description: '集運', amount: 100, payer: 1 }] };

test('依賣場商品合併不同訂單：數量、成本、售價、內扣與獲利保持原始金額', () => {
  const product={id:'p',name:'商品',foreign_cost:400,exchange_rate:0.2};
  const rows=procurementProfitGroups([{...item,product_id:'p',buyer_key:'buyer1',deduction:100},{...item,id:'b',product_id:'p',quantity:2,unit_price:1400,unit_cost:800,buyer_key:'buyer2',deduction:0}],[{id:'m',name:'賣場',products:[product]}]);
  assert.equal(rows.length,1);assert.equal(rows[0].rows.length,1);
  const row=rows[0].rows[0];
  assert.equal(row.quantity,3);assert.equal(row.totalCost,2600);assert.equal(row.revenue,4300);
  assert.equal(row.cost,867);assert.equal(row.buyers,2);assert.equal(row.profit,1600);
  assert.deepEqual(row.items.map(item=>item.id),['a','b']);
});

test('整數比例平均分配：第一位優先補差值', () => {
  assert.deepEqual(equalProfitRatios(1), [100]);
  assert.deepEqual(equalProfitRatios(2), [50, 50]);
  assert.deepEqual(equalProfitRatios(3), [34, 33, 33]);
  assert.deepEqual(equalProfitRatios(6), [20, 16, 16, 16, 16, 16]);
});
test('單人與多人均支援成本代墊、虧損和分配尾差', () => {
  for (const count of [1, 3, 6]) for (const received of [0, 1500, 1500.01]) {
    const config = { ...settings, parties: equalProfitRatios(count).map((ratio, index) => ({name:`分潤人${index+1}`,ratio})), collector:count-1, expenses:[{description:'集運',amount:100,payer:count-1}] };
    const result = calculateProfitShare([item], {...config, received});
    assert.equal(result.parties.length,count);
    assert.equal(Math.round(result.parties.reduce((sum, party)=>sum+party.share,0)*100),Math.round(result.profit*100));
    assert.equal(Math.round(result.parties.reduce((sum, party)=>sum+party.balance,0)*100),0);
  }
  assert.throws(()=>calculateProfitShare([item], {...settings,parties:[{name:'我',ratio:50.5},{name:'老婆',ratio:49.5}]}),/整數/);
  assert.throws(()=>calculateProfitShare([item], {...settings,collector:2}));
  for (const received of [1100.01, 1099.99]) {
    const result = calculateProfitShare([item], {...settings,received,parties:[{name:'A',ratio:0},{name:'B',ratio:50},{name:'C',ratio:50}]});
    assert.equal(Math.abs(result.parties[0].share),0,'Zero ratio must not receive rounding income or debt');
    assert.equal(Math.round(result.parties.reduce((sum,party)=>sum+party.share,0)*100),Math.round(result.profit*100));
  }
});

test('先退代墊款再五五分：老婆收款 1500，應轉给我 1200', () => {
  const result = calculateProfitShare([item], settings);
  assert.equal(result.profit, 400);
  assert.deepEqual(result.parties.map((party) => party.share), [200, 200]);
  assert.deepEqual(result.parties.map((party) => party.balance), [1200, -1200]);
});
test('變更收帳人與比例仍保持收支平衡', () => {
  const result = calculateProfitShare([item], { ...settings, collector: 0, parties: [{ name: '我', ratio: 60 }, { name: '老婆', ratio: 40 }] });
  assert.deepEqual(result.parties.map((party) => party.share), [240, 160]);
  assert.deepEqual(result.parties.map((party) => party.balance), [-260, 260]);
});
test('分潤尾數與虧損均保持平衡', () => {
  for (const received of [0, 1000.01, 1100.01, 1100.03]) {
    const result = calculateProfitShare([item], { ...settings, received });
    assert.equal(Math.round(result.parties.reduce((sum, party) => sum + party.share, 0) * 100), Math.round(result.profit * 100));
    assert.equal(Math.round(result.parties.reduce((sum, party) => sum + party.balance, 0) * 100), 0);
  }
});
test('拒絕未入帳、無效比例與無效額外成本', () => {
  assert.throws(() => calculateProfitShare([item], { ...settings, receivedConfirmed: false }));
  assert.throws(() => calculateProfitShare([item], { ...settings, parties: [{ name: '我', ratio: 30 }, { name: '老婆', ratio: 30 }] }));
  assert.throws(() => calculateProfitShare([item], { ...settings, expenses: [{ description: '集運', amount: -1, payer: 0 }] }));
});
test('來源只限發貨已完成：排除待發貨、僅已發貨、取消與已分潤品項', () => {
  const orders = [{ id:'order',status:'confirmed',order_items:['pending','shipped','completed','settled','completed-again'].map(id=>({...item,id,product_id:'same-product'})) },{status:'cancelled',order_items:[{...item,id:'cancelled'}]}];
  const checks = new Map([['shipped',{shipped_at:'2026-10-01'}],...['completed','settled','completed-again','cancelled'].map(id=>[id,{shipped_at:'2026-10-01',completed_at:'2026-10-02'}])]);
  assert.deepEqual(completedProfitItems(orders,checks,new Set(['settled']),entry=>entry.unit_cost).map(entry=>entry.id),['completed','completed-again']);
  checks.get('completed').completed_at=null;
  assert.deepEqual(completedProfitItems(orders,checks,new Set(['settled']),entry=>entry.unit_cost).map(entry=>entry.id),['completed-again']);
});
test('還原提醒重新讀取已分潤紀錄，不能因本地資料過期漏掉提醒', async () => {
  let records = [];
  const controller = createProfitSharing({ state: { user: { id: 'admin' }, profile: { role: 'owner' }, orders: [], procurementChecks: new Map() }, supabase: { from: () => ({ select: () => ({ order: async () => ({ data: records }) }) }) }, esc: String, money: String, getCost: () => 0 });
  await controller.load();
  records = [{ id: 'settlement', snapshot: { items: [{ id: 'a' }] } }];
  const warning = await controller.restoreWarning(['a', 'b']);
  assert.equal(warning.count, 1);
  assert.match(warning.message, /不會再次進入待分潤/);
});
