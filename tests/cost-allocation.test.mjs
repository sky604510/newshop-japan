import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateQuantities, allocationSummary, calculateProfitShare } from '../profit-sharing.js';

test('共同分擔按穩定的訂單品項記錄，部分結算仍沿用原分配', () => {
  const items = [{ id: 'b', quantity: 2 }, { id: 'a', quantity: 1 }];
  const allocations = allocateQuantities(items, 2);
  assert.deepEqual(allocations, { a: [1, 0], b: [1, 1] });
  assert.deepEqual(allocateQuantities([...items].reverse(), 2), allocations);
  assert.equal(allocationSummary(items, allocations).label, '豪 2／盈 1');
  assert.equal(allocationSummary([{ id: 'b', quantity: 3 }], allocations).mode, '');
  const settings = { parties: [{name:'豪',ratio:50},{name:'盈',ratio:50}], collector:1, received:3100, receivedConfirmed:true, payers:{b:0}, allocations, expenses:[] };
  const result = calculateProfitShare([{id:'b',quantity:2,unit_cost:1330,unit_price:1550}], settings);
  assert.equal(result.profit, 440);
  assert.deepEqual(result.parties.map(p => p.advance), [1330,1330]);
  assert.deepEqual(result.parties.map(p => p.share), [220,220]);
  assert.deepEqual(result.parties.map(p => p.balance), [1550,-1550]);
});

test('全數歸一人、件數檢查、虧損與共同分擔尾差', () => {
  assert.deepEqual(allocateQuantities([{id:'a',quantity:3}],0), {a:[0,3]});
  for (const count of [-1,4,1.5,NaN]) assert.throws(() => allocateQuantities([{id:'a',quantity:3}],count));
  const settings = {parties:[{name:'豪',ratio:50},{name:'盈',ratio:50}],collector:0,received:0,receivedConfirmed:true,payers:{a:0},allocations:{a:[1,2]},expenses:[]};
  const result = calculateProfitShare([{id:'a',quantity:3,unit_cost:0.335,unit_price:1}],settings);
  assert.deepEqual(result.parties.map(p=>p.advance),[0.34,0.67]);
  assert.equal(Math.round(result.parties.reduce((sum,p)=>sum+p.balance,0)*100),0);
  assert.throws(() => calculateProfitShare([{id:'a',quantity:2,unit_cost:1,unit_price:1}],settings), /件數/);
});
