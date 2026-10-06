export const COST_PEOPLE = ['豪', '盈'];

export function validAllocation(value, quantity) {
  return Array.isArray(value) && value.length === 2 && value.every((n) => Number.isSafeInteger(n) && n >= 0) && value[0] + value[1] === Number(quantity);
}

export function allocateQuantities(items, haoQuantity) {
  const total = items.reduce((sum, item) => sum + Number(item.quantity), 0);
  if (!Number.isSafeInteger(haoQuantity) || haoQuantity < 0 || haoQuantity > total) throw new Error('豪的件數須為 0 到商品總數量的整數');
  let remaining = haoQuantity;
  return Object.fromEntries([...items].sort((a, b) => a.id.localeCompare(b.id)).map((item) => {
    const hao = Math.min(remaining, Number(item.quantity)); remaining -= hao;
    return [item.id, [hao, Number(item.quantity) - hao]];
  }));
}

export function allocationSummary(items, allocations = {}) {
  const counts = [0, 0];
  for (const item of items) {
    const value = allocations[item.id];
    if (!validAllocation(value, item.quantity)) return { mode: '', label: '未指定／數量已變更', counts };
    counts[0] += value[0]; counts[1] += value[1];
  }
  return { counts, mode: counts[1] === 0 ? '0' : counts[0] === 0 ? '1' : 'shared', label: counts[1] === 0 ? '豪' : counts[0] === 0 ? '盈' : `豪 ${counts[0]}／盈 ${counts[1]}` };
}

const cents = (value) => Math.round(Number(value) * 100);

export function equalProfitRatios(count) {
  if (!Number.isInteger(count) || count < 1) throw new Error('至少需要一位分潤人');
  const base = Math.floor(100 / count);
  return Array.from({ length: count }, (_, index) => base + (index === 0 ? 100 - base * count : 0));
}

export function calculateProfitShare(items, settings) {
  const parties = settings.parties.map((party) => ({ ...party, advance: 0, share: 0, balance: 0 }));
  if (!parties.length || parties.some((party) => !party.name.trim() || !Number.isInteger(Number(party.ratio)) || party.ratio < 0 || party.ratio > 100) || new Set(parties.map((party) => party.name.trim())).size !== parties.length || parties.reduce((sum, party) => sum + Number(party.ratio), 0) !== 100) throw new Error('請填寫不同的分潤人名稱，比例須為整數且合計 100%');
  const validParty = (index) => Number.isInteger(index) && index >= 0 && index < parties.length;
  if (!validParty(settings.collector) || !Number.isFinite(settings.received) || settings.received < 0 || !settings.receivedConfirmed) throw new Error('請確認收帳人、實際入帳金額，並勾選已確認入帳');
  let revenue = 0, itemCost = 0, extraCost = 0;
  for (const item of items) {
    const payer = settings.payers[item.id];
    if (!validParty(payer)) throw new Error('請指定商品成本付款人');
    const cost = cents(item.unit_cost * item.quantity);
    itemCost += cost; revenue += cents(item.unit_price * item.quantity); const allocation = settings.allocations?.[item.id];
    if (allocation) {
      if (!validAllocation(allocation, item.quantity) || parties.length !== 2) throw new Error('商品成本分配件數不正確');
      const first = cents(item.unit_cost * allocation[0]);
      parties[0].advance += first; parties[1].advance += cost - first;
    } else parties[payer].advance += cost;
  }
  for (const expense of settings.expenses) {
    if (!expense.description.trim() || !Number.isFinite(expense.amount) || expense.amount < 0 || !validParty(expense.payer)) throw new Error('請填寫額外成本用途、金額與付款人');
    const cost = cents(expense.amount); extraCost += cost; parties[expense.payer].advance += cost;
  }
  const received = cents(settings.received), profit = received - itemCost - extraCost;
  const magnitude = Math.abs(profit);
  parties.forEach((party) => { party.share = Math.floor(magnitude * Number(party.ratio) / 100); });
  const remainder = magnitude - parties.reduce((sum, party) => sum + party.share, 0);
  const priority = parties.map((party, index) => ({ index, fraction: (magnitude * Number(party.ratio)) % 100 })).sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  priority.slice(0, remainder).forEach(({ index }) => { parties[index].share++; });
  if (profit < 0) parties.forEach((party) => { party.share = -party.share; });
  parties.forEach((party, index) => { party.balance = party.advance + party.share - (index === settings.collector ? received : 0); });
  return { revenue: revenue / 100, received: received / 100, item_cost: itemCost / 100, extra_cost: extraCost / 100, profit: profit / 100, collector: settings.collector, parties: parties.map((party) => ({ ...party, advance: party.advance / 100, share: party.share / 100, balance: party.balance / 100 })), expenses: settings.expenses.map((expense) => ({ ...expense, amount: cents(expense.amount) / 100 })), items: items.map((item) => ({ ...item, payer: settings.payers[item.id], ...(settings.allocations?.[item.id] ? { allocation: settings.allocations[item.id] } : {}) })) };
}

export function procurementProfitGroups(items, markets = [], products = []) {
  const catalog = new Map(products.map((product) => [product.id, product]));
  markets.forEach((market) => market.products.forEach((product) => catalog.set(product.id, { ...product, market_id: market.id })));
  const groups = new Map();
  for (const item of items) {
    const product = catalog.get(item.product_id) || { id: item.product_id || item.id, name: item.name, market_id: item.market_id, foreign_cost: 0, exchange_rate: 0 };
    const market = markets.find((entry) => entry.id === product.market_id) || { id: product.market_id || 'unknown-market', name: product.market_name || '原賣場（資料未保留）', products: [] };
    if (!groups.has(market.id)) groups.set(market.id, { market, rows: new Map() });
    const rows = groups.get(market.id).rows;
    if (!rows.has(product.id)) rows.set(product.id, { product, items: [], quantity: 0, revenue: 0, deduction: 0, totalCost: 0, buyerKeys: new Set() });
    const row = rows.get(product.id); row.items.push(item); row.quantity += Number(item.quantity);
    row.revenue += cents(item.unit_price * item.quantity) / 100;
    row.deduction += Number(item.deduction || 0); row.totalCost += cents(item.unit_cost * item.quantity) / 100;
    row.buyerKeys.add(Object.hasOwn(item, 'buyer_key') ? item.buyer_key : item.recipient);
  }
  return [...groups.values()].sort((a, b) => markets.indexOf(a.market) - markets.indexOf(b.market)).map(({ market, rows }) => ({ market, rows: [...rows.values()].sort((a, b) => market.products.findIndex((entry) => entry.id === a.product.id) - market.products.findIndex((entry) => entry.id === b.product.id)).map((row) => ({ ...row, cost: Math.round(row.quantity ? row.totalCost / row.quantity : 0), price: row.quantity ? row.revenue / row.quantity : 0, buyers: row.buyerKeys.size, profit: row.revenue - row.totalCost })) }));
}

export function completedProfitItems(orders, fulfillmentChecks, settled, getCost, getDeduction = () => 0) {
  return orders.filter((order) => order.status !== 'cancelled').flatMap((order) => (order.order_items || []).filter((item) => {
    const fulfillment = fulfillmentChecks.get(item.id);
    return Boolean(fulfillment?.shipped_at && fulfillment?.completed_at && fulfillment?.reconciled_at) && !settled.has(item.id);
  }).map((item) => ({ id: item.id, order_id: order.id, order_number: order.order_number, recipient: order.recipient_name, buyer_key: order.customer_id || order.phone, market_id: item.market_id, name: item.product_name, quantity: Number(item.quantity), unit_price: Number(item.unit_price), unit_cost: getCost(item), product_id: item.product_id, deduction: getDeduction(order, item) })));
}

export function createProfitSharing({ state, supabase, esc, money, getCost, getDeduction = () => 0, render, toast, reload, bindBackdropClose }) {
  let step = 'select';
  let stickyObserver;
  let ready = false, settlements = [], settled = new Set(), view = 'pending', draft = null, preview = null, busy = false;
  const pending = () => completedProfitItems(state.orders, state.fulfillmentChecks, settled, getCost, getDeduction).map((item) => ({ ...item, image_url: (state.products || []).find((product) => product.id === item.product_id)?.image_url || '' }));
  const freshDraft = () => ({ selected: new Set(), title: '', parties: [{ name: '豪', ratio: 50 }, { name: '盈', ratio: 50 }], collector: 0, received: '', receivedConfirmed: false, payers: {}, allocations: {}, expenses: [] });
  const options = (selected) => draft.parties.map((party, index) => `<option value="${index}" ${index === selected ? 'selected' : ''}>${esc(party.name || `分潤人 ${index + 1}`)}</option>`).join('');
  const chosen = () => pending().filter((item) => draft?.selected.has(item.id));
  const chosenAmount = () => chosen().reduce((sum, item) => sum + cents(item.unit_price * item.quantity), 0) / 100;
  const groupsFor = (items) => procurementProfitGroups(items.map((item) => ({ ...item, product_id: item.product_id || state.orders.flatMap((order) => order.order_items || []).find((row) => row.id === item.id)?.product_id })), state.markets || [], state.products || []);
  const selectionText = () => `已選 ${groupsFor(chosen()).reduce((sum, group) => sum + group.rows.length, 0)} 個商品・${chosen().reduce((sum, item) => sum + item.quantity, 0)} 件・商品銷售合計 ${money(chosenAmount())}`;
  const zeroCostGroups = () => groupsFor(chosen()).map((group) => ({ ...group, rows: group.rows.filter((row) => row.items.some((item) => Number(item.unit_cost) === 0)) })).filter((group) => group.rows.length);
  function enterSettings() {
    if (!chosen().length) { step = 'select'; render(); toast('沒有保留的商品，請重新選擇要分潤的商品'); return; }
    try { syncAllocations(); } catch (error) { toast(error.message); return; }
    step = 'settings'; render();
  }
  function syncAllocations() {
    draft.allocations = {}; draft.payers = {};
    for (const item of chosen()) {
      const allocation = state.procurementChecks.get(item.product_id)?.cost_allocations?.[item.id];
      if (!validAllocation(allocation, item.quantity)) throw new Error('請先到採購清單指定成本人；數量變更後須重新分配');
      draft.allocations[item.id] = [...allocation];
      draft.payers[item.id] = allocation[0] ? 0 : 1;
    }
  }
  async function load() {
    if (!state.user || !['admin', 'owner'].includes(state.profile?.role)) { ready = false; settlements = []; settled = new Set(); draft = null; preview = null; return; }
    const { data, error } = await supabase.from('profit_share_settlements').select('id,completed_at,snapshot').order('completed_at', { ascending: false });
    if (error) {
      ready = false; settlements = []; settled = new Set();
      if (/profit_share_settlements|schema cache|does not exist/i.test(error.message || '')) return;
      throw error;
    }
    ready = true; settlements = data || []; settled = new Set(settlements.flatMap((entry) => entry.snapshot.items.map((item) => item.id)));
    if (draft) draft.selected = new Set([...draft.selected].filter((id) => pending().some((item) => item.id === id)));
  }
  function capture() {
    const root = document.querySelector('[data-profit-form]'); if (!root || !draft) return;
    if (!root.querySelector('[data-profit-title]')) return;
    draft.title = root.querySelector('[data-profit-title]').value;
    draft.parties = [...root.querySelectorAll('[data-profit-party]')].map((row, index) => ({ name: COST_PEOPLE[index], ratio: row.querySelector('[data-profit-ratio]').value === '' ? NaN : Number(row.querySelector('[data-profit-ratio]').value) }));
    draft.collector = Number(root.querySelector('[data-profit-collector]').value);
    draft.received = root.querySelector('[data-profit-received]').value;
    draft.receivedConfirmed = root.querySelector('[data-profit-confirmed]').checked;
    draft.expenses = [...root.querySelectorAll('[data-profit-expense]')].map((row) => ({ key: row.dataset.profitExpense, description: row.querySelector('[data-profit-expense-name]').value, amount: Number(row.querySelector('[data-profit-expense-amount]').value), payer: Number(row.querySelector('[data-profit-expense-payer]').value) }));
  }
  function expenseRow(expense) {
    return `<div class="profit-expense" data-profit-expense="${expense.key}"><label>用途<input data-profit-expense-name value="${esc(expense.description)}" placeholder="集運費、包材…"/></label><label>金額<input data-profit-expense-amount type="number" min="0" step="0.01" value="${expense.amount}"/></label><label>付款人<select data-profit-expense-payer>${options(expense.payer)}</select></label><button class="btn btn-danger-soft" type="button" data-profit-remove-expense="${expense.key}">移除</button></div>`;
  }
  function itemThumbnail(item) {
    const productId = item.product_id || state.orders.flatMap((order) => order.order_items || []).find((row) => row.id === item.id)?.product_id;
    const url = item.image_url || (state.products || []).find((product) => product.id === productId)?.image_url;
    return `<span class="profit-item-thumb"${url ? '' : ' aria-label="無圖片"'}>${url ? `<img src="${esc(url)}" alt="" loading="lazy"/>` : ''}</span>`;
  }
  function resultHtml(result) {
    const creditors = result.parties.map((party) => ({ name: party.name, amount: cents(party.balance) })).filter((party) => party.amount > 0);
    const debtors = result.parties.map((party) => ({ name: party.name, amount: -cents(party.balance) })).filter((party) => party.amount > 0);
    const transfers = [];
    for (const sender of debtors) for (const receiver of creditors) {
      const amount = Math.min(sender.amount, receiver.amount);
      if (amount > 0) { transfers.push(`${esc(sender.name)} 應轉給 ${esc(receiver.name)} ${money(amount / 100)}`); sender.amount -= amount; receiver.amount -= amount; }
    }
    const extraCosts = result.expenses.length ? `<h3>額外成本</h3>${result.expenses.map((expense) => `<p>${esc(expense.description)}・${money(expense.amount)}・${esc(result.parties[expense.payer].name)} 付款</p>`).join('')}` : '';
    return `<div class="profit-totals"><p>商品銷售金額<strong>${money(result.revenue)}</strong></p><p>實際入帳<strong>${money(result.received)}</strong></p><p>商品成本<strong>${money(result.item_cost)}</strong></p><p>額外成本<strong>${money(result.extra_cost)}</strong></p><p>可分${result.profit < 0 ? '虧損' : '利潤'}<strong>${money(result.profit)}</strong></p></div><div class="profit-party-results">${result.parties.map((party, index) => `<article><strong>${esc(party.name)}（${party.ratio}%）${index === result.collector ? '・收帳人' : ''}</strong><p>代墊款 ${money(party.advance)}</p><p>分得${party.share < 0 ? '虧損' : '利潤'} ${money(party.share)}</p><p>應${party.balance < 0 ? '轉出' : '收取'} ${money(Math.abs(party.balance))}</p></article>`).join('')}</div><div class="profit-transfer">${transfers.length ? transfers.join('<br/>') : '本次不需互相轉帳'}</div>${extraCosts}<section class="profit-result-items"><h3>本次商品統計</h3>${marketList(result.items, 'result', result.parties)}</section>`;
  }
  function costLabel(items, mode, parties) {
    const counts = [0, 0];
    for (const item of items) {
      const allocation = mode === 'result' ? item.allocation : state.procurementChecks.get(item.product_id)?.cost_allocations?.[item.id];
      if (validAllocation(allocation, item.quantity)) { counts[0] += allocation[0]; counts[1] += allocation[1]; }
      else if (mode === 'result') return [...new Set(items.map((entry) => parties[entry.payer]?.name || '未記錄'))].map(esc).join('、');
      else return '未指定／數量已變更';
    }
    return counts.map((count, index) => count ? esc((parties?.[index]?.name || COST_PEOPLE[index]) + ' ×' + count) : '').filter(Boolean).join('、');
  }
  function marketList(items, mode = 'select', parties = []) {
    const groups = groupsFor(items);
    return `<div class="summary-grid profit-market-list">${groups.map(({market, rows}) => {
      const totalProfit = rows.reduce((sum, row) => sum + row.profit, 0), quantity = rows.reduce((sum, row) => sum + row.quantity, 0);
      const all = rows.flatMap((row) => row.items);
      const rates = rows.map((row) => Number(row.product.exchange_rate || 0)).filter((rate) => rate > 0);
      const averageRate = rates.length ? rates.reduce((sum, rate) => sum + rate, 0) / rates.length : 0;
      return `<article class="summary-card" data-profit-market-card="${esc(market.id)}"><div class="summary-head"><h3>${mode === 'select' ? `<input type="checkbox" data-profit-market="${esc(market.id)}" aria-label="選取 ${esc(market.name)} 全部商品" ${all.every((item) => draft.selected.has(item.id)) ? 'checked' : ''}/>` : ''}${esc(market.name)}</h3><span>獲利 ${money(totalProfit)}</span></div><div class="mobile-table-hint" aria-hidden="true">← 左右滑動查看完整商品統計 →</div><div class="table-wrap"><table class="admin-table procurement-table profit-market-table"><thead><tr><th>${mode === 'select' ? '選取' : ''}</th><th>商品</th><th>數量</th><th>外幣成本</th><th>匯率</th><th>單件成本</th><th>售價</th><th>購買人數</th><th>獲利</th>${mode !== 'select' ? '<th>成本付款人</th>' : ''}</tr></thead><tbody>${rows.map((row) => `<tr data-profit-product-row="${esc(row.product.id)}"><td>${mode === 'select' ? `<input class="procurement-check" type="checkbox" data-profit-product="${esc(row.product.id)}" aria-label="選取 ${esc(row.product.name)}" ${row.items.every((item) => draft.selected.has(item.id)) ? 'checked' : ''}/>` : ''}</td><td><div class="procurement-product">${itemThumbnail({...row.items[0],image_url:row.product.image_url})}<span><strong>${esc(mode === 'result' ? row.items[0].name : row.product.name)}</strong><small>${esc(market.name)}</small></span></div></td><td><strong>${row.quantity}</strong></td><td>${Number(row.product.foreign_cost || 0).toLocaleString('zh-TW')}</td><td>${Number(row.product.exchange_rate || 0).toLocaleString('zh-TW')}</td><td>${money(row.cost)}</td><td>${money(row.price)}</td><td>${row.buyers}</td><td class="profit ${row.profit < 0 ? 'negative' : ''}">${money(row.profit)}</td>${mode !== 'select' ? `<td>${costLabel(row.items, mode, parties)}</td>` : ''}</tr>`).join('')}</tbody><tfoot><tr class="procurement-subtotal"><td></td><td><strong>小計</strong></td><td><strong>${quantity}</strong></td><td>${rows.reduce((sum,row)=>sum+Number(row.product.foreign_cost || 0)*row.quantity,0).toLocaleString('zh-TW',{maximumFractionDigits:2})}</td><td>${averageRate.toLocaleString('zh-TW', { maximumFractionDigits: 4 })}</td><td>—</td><td>—</td><td>${rows.reduce((sum,row)=>sum+row.buyers,0)}</td><td class="profit"><strong>${money(totalProfit)}</strong></td>${mode !== 'select' ? '<td></td>' : ''}</tr></tfoot></table></div></article>`;
    }).join('') || '<div class="empty">目前沒有發貨清單中已完成且尚未分潤的商品</div>'}</div>`;
  }
  function marketStats(items) {
    const rows = groupsFor(items).flatMap((group) => group.rows);
    return `<div class="admin-stats procurement-stats"><div class="stat"><small>本頁商品總數</small><strong>${rows.reduce((sum, row) => sum + row.quantity, 0)}</strong></div><div class="stat"><small>本頁未分潤商品</small><strong>${rows.length}</strong></div><div class="stat"><small>本頁訂單獲利</small><strong>${money(rows.reduce((sum, row) => sum + row.profit, 0))}</strong></div></div>`;
  }
  function partyTable() {
    return `<h3>分潤人</h3><div class="table-wrap"><table class="admin-table profit-party-table"><thead><tr><th>分潤人名稱</th><th>比例（%）</th></tr></thead><tbody>${draft.parties.map((party) => `<tr data-profit-party><td><strong>${esc(party.name)}</strong></td><td><input data-profit-ratio aria-label="${esc(party.name)} 分潤比例" type="number" min="0" max="100" step="1" value="${Number.isFinite(party.ratio) ? party.ratio : ''}"/></td></tr>`).join('')}</tbody></table></div><p data-profit-ratio-total class="draft-hint">比例合計：${draft.parties.reduce((sum, party) => sum + party.ratio, 0)}%（須為 100%，不使用小數）</p>`;
  }

  function panel() {
    if (!draft) draft = freshDraft();
    const header = `<div class="section-head"><div><span class="eyebrow">PROFIT SHARING</span><h2>分潤清單</h2><p>只從發貨清單「已完成」載入，依賣場與商品彙整；已分潤部分不重複結算。</p></div></div><div class="sub-tabs"><button data-profit-view="pending" class="${view === 'pending' ? 'active' : ''}">待分潤</button><button data-profit-view="settled" class="${view === 'settled' ? 'active' : ''}">已分潤</button></div>`;
    if (!ready) return `<section class="panel">${header}<div class="empty">分潤功能尚未啟用，請先執行 profit_sharing_upgrade.sql。</div></section>`;
    if (view === 'settled') return `<section class="panel">${header}${settlements.map((entry) => `<article class="profit-history"><div><strong>${esc(entry.snapshot.title || '分潤批次')}</strong><p>分潤時間：${new Date(entry.completed_at).toLocaleString('zh-TW')}</p><p>${entry.snapshot.items.length} 個品項・入帳 ${money(entry.snapshot.received)}・利潤 ${money(entry.snapshot.profit)}</p>${entry.snapshot.items.some((item) => state.orders.some((order) => (order.order_items || []).some((row) => row.id === item.id)) && !state.fulfillmentChecks.get(item.id)?.reconciled_at) ? '<p class="profit-warning">部分品項已從已完成還原；本批分潤紀錄仍保留。</p>' : ''}</div><button class="btn btn-light" data-profit-history="${entry.id}">查看結果</button></article>`).join('') || '<div class="empty">尚無已分潤紀錄</div>'}</section>`;
    const steps = `<ol class="profit-steps" aria-label="分潤步驟">${['選擇商品', '分潤設定', '結果確認'].map((label, index) => `<li class="${['select', 'settings', 'result'].indexOf(step) === index ? 'active' : ''}"><span>${index + 1}</span>${label}</li>`).join('')}</ol>`;
    if (step === 'result' && preview && !preview.id) return `<section class="panel">${header}${steps}<h3>${esc(preview.result.title || '分潤結果')}</h3>${resultHtml(preview.result)}<div class="profit-step-actions"><button class="btn btn-light" data-profit-back="settings" ${busy ? 'disabled' : ''}>返回設定</button><button class="btn btn-primary" data-profit-finish ${busy ? 'disabled' : ''}>${busy ? '儲存中…' : '分潤完成'}</button></div><p class="draft-hint">確認轉帳完成後，再按「分潤完成」保存帳目與時間。</p></section>`;
    if (step === 'select') return `<section class="panel">${header}${steps}<div data-profit-form>${marketStats(pending())}<div class="profit-selection-bar"><strong data-profit-selection>${selectionText()}</strong><button class="btn btn-primary" data-profit-next ${chosen().length ? '' : 'disabled'}>下一步 →</button></div>${marketList(pending())}</div></section>`;
    return `<section class="panel">${header}${steps}<div data-profit-form><div class="profit-settings"><label>分潤名稱<input data-profit-title value="${esc(draft.title)}" placeholder="例如：10 月第一批分潤"/></label><label>收帳人<select data-profit-collector>${options(draft.collector)}</select></label></div>${partyTable()}<h3 class="profit-block-title">已選商品與成本付款人</h3>${marketList(chosen(), 'settings')}<div class="section-head"><h3>額外成本</h3><button class="btn btn-light" type="button" data-profit-add-expense>＋ 新增成本</button></div><div data-profit-expenses>${draft.expenses.map(expenseRow).join('')}</div><div class="profit-income"><label>本批實際入帳金額（含抵用訂金）<input data-profit-received type="number" min="0" step="0.01" value="${esc(draft.received === '' ? chosenAmount() : draft.received)}"/></label><label class="inline-check"><input data-profit-confirmed type="checkbox" ${draft.receivedConfirmed ? 'checked' : ''}/> 已確認本批貨款入帳</label></div><div class="profit-step-actions"><button class="btn btn-light" type="button" data-profit-back="select">← 返回選商品</button><button class="btn btn-primary" type="button" data-profit-calculate>計算分潤 →</button></div></div></section>`;
  }
  function modal() {
    if (state.modal === 'profit-zero-cost') return `<div class="modal-backdrop"><div class="modal profit-zero-cost-modal" role="dialog" aria-modal="true" aria-labelledby="profit-zero-cost-title"><div class="modal-head"><h2 id="profit-zero-cost-title">零成本商品確認</h2><button class="close" data-profit-zero-close aria-label="關閉">×</button></div><p class="profit-warning">以下商品含有成本為 NT$ 0 的訂單品項，請確認成本是否正確。只有勾選的商品會繼續參與本次分潤。</p><div class="profit-zero-list">${zeroCostGroups().map(({market, rows}) => `<section><h3>${esc(market.name)}</h3>${rows.map((row) => `<label class="profit-zero-row"><input type="checkbox" data-profit-zero-product="${esc(row.product.id)}"/>${itemThumbnail({...row.items[0],image_url:row.product.image_url})}<span><strong>${esc(row.product.name)}</strong><small>數量 ${row.quantity}・商品金額 ${money(row.revenue)}・${row.items.every((item) => Number(item.unit_cost) === 0) ? '成本 NT$ 0' : '部分訂單品項成本為 NT$ 0'}</small></span></label>`).join('')}</section>`).join('')}</div><p class="draft-hint">未勾選的商品會從本次選取中排除；有成本的其他商品會保留，不會刪除訂單或採購資料。</p><div class="profit-step-actions"><button class="btn btn-light" data-profit-zero-close>返回選擇</button><button class="btn btn-primary" data-profit-zero-confirm>確認並下一步 →</button></div></div></div>`;
    if (!preview) return '';
    return `<div class="modal-backdrop"><div class="modal profit-result-modal"><div class="modal-head"><h2>${esc(preview.result.title || '分潤結果')}</h2><button class="close" data-profit-close>×</button></div>${preview.completed_at ? `<p>分潤時間：${new Date(preview.completed_at).toLocaleString('zh-TW')}</p>` : ''}${resultHtml(preview.result)}${preview.id ? '' : '<p>確認轉帳完成後，按下「分潤完成」保存本次帳目。</p><button class="btn btn-primary" data-profit-finish>分潤完成</button>'}</div></div>`;
  }
  async function calculate() {
    capture();
    try {
      syncAllocations(); const items = chosen(); if (!items.length) throw new Error('請選擇要分潤的品項');
      if (draft.received === '') throw new Error('請填寫實際入帳金額');
      const settings = { ...draft, received: Number(draft.received) };
      const result = calculateProfitShare(items, settings); result.title = draft.title.trim();
      preview = { result, settings }; step = 'result'; state.modal = null; render();
    } catch (error) { toast(error.message); }
  }
  async function finish() {
    if (busy || !preview || preview.id) return;
    busy = true; const button = document.querySelector('[data-profit-finish]'); if (button) { button.disabled = true; button.textContent = '儲存中…'; }
    try {
      const { data, error } = await supabase.rpc('admin_complete_profit_share_v3', { p_item_ids: preview.result.items.map((item) => item.id), p_settings: { ...preview.settings, selected: undefined, expected_items: preview.result.items } });
      if (error) throw error;
      const record = Array.isArray(data) ? data[0] : data;
      if (!record?.snapshot?.items) throw new Error('分潤結果回傳異常，請重新載入已分潤清單確認');
      settlements.unshift(record); settled = new Set([...settled, ...record.snapshot.items.map((item) => item.id)]);
      draft = freshDraft(); step = 'select'; preview = null; state.modal = null; view = 'settled'; render(); toast('分潤完成，已保存結算結果與時間');
    } catch (error) {
      const messages = { PROFIT_COST_ALLOCATION_CHANGED: '成本分配已變更，請回到採購清單確認後重新計算', INVALID_PROFIT_SETTINGS: '請確認入帳金額、分潤比例與成本付款人', PROFIT_ITEM_STATE_CHANGED: '部分品項已不在發貨清單的已完成資料，請重新選取', PROFIT_ITEM_ALREADY_SETTLED: '部分品項已分潤，請重新選取', PROFIT_ITEM_AMOUNT_CHANGED: '訂單金額或成本已變更，請重新計算' };
      toast(/admin_complete_profit_share_v3|schema cache/i.test(error.message || '') ? '請先執行 procurement_cost_people_upgrade.sql，啟用已完成商品分潤' : messages[error.message] || error.message);
      if (/PROFIT_ITEM_/.test(error.message)) {
        try { await reload(); await load(); preview = null; step = 'select'; state.modal = null; render(); }
        catch (refreshError) { toast(`重新載入失敗：${refreshError.message}`); }
      }
    } finally { busy = false; if (button?.isConnected) { button.disabled = false; button.textContent = '分潤完成'; } }
  }
  function bind() {
    document.querySelectorAll('[data-profit-view]').forEach((button) => button.addEventListener('click', () => { if (busy) return; capture(); view = button.dataset.profitView; if (preview && !preview.id) { preview = null; step = 'settings'; } render(); }));
    document.querySelectorAll('[data-profit-history]').forEach((button) => button.addEventListener('click', () => { const entry = settlements.find((row) => row.id === button.dataset.profitHistory); preview = { id: entry.id, completed_at: entry.completed_at, result: entry.snapshot }; state.modal = 'profit-result'; render(); }));
    const root = document.querySelector('[data-profit-form]');
    stickyObserver?.disconnect();
    const tabs = document.querySelector('.admin-tabs');
    if (root && tabs) {
      const updateOffset = () => root.style.setProperty('--profit-sticky-top', `${parseFloat(getComputedStyle(tabs).top) + tabs.getBoundingClientRect().height + 10}px`);
      updateOffset(); stickyObserver = new ResizeObserver(updateOffset); stickyObserver.observe(tabs);
    }
    root?.addEventListener('input', () => {
      capture();
      const total = root.querySelector('[data-profit-ratio-total]');
      if (total) total.textContent = `比例合計：${draft.parties.reduce((sum, party) => sum + party.ratio, 0)}%（須為 100%，不使用小數）`;
    });
    root?.addEventListener('change', (event) => {
      const input = event.target; capture();
      if (input.matches('[data-profit-product],[data-profit-market]')) {
        const rows = groupsFor(pending()).flatMap((group) => input.matches('[data-profit-market]') ? (group.market.id === input.dataset.profitMarket ? group.rows : []) : group.rows.filter((row) => row.product.id === input.dataset.profitProduct));
        rows.flatMap((row) => row.items).forEach((item) => { if (input.checked) draft.selected.add(item.id); else draft.selected.delete(item.id); });
        groupsFor(pending()).forEach((group) => {
          const card = [...root.querySelectorAll('[data-profit-market-card]')].find((el) => el.dataset.profitMarketCard === group.market.id);
          const update = (check, items) => { check.checked = items.every((item) => draft.selected.has(item.id)); check.indeterminate = !check.checked && items.some((item) => draft.selected.has(item.id)); };
          if (!card) return; update(card.querySelector('[data-profit-market]'), group.rows.flatMap((row) => row.items));
          group.rows.forEach((row) => update([...card.querySelectorAll('[data-profit-product]')].find((el) => el.dataset.profitProduct === row.product.id), row.items));
        });
        draft.received = chosenAmount(); draft.receivedConfirmed = false;
        root.querySelector('[data-profit-next]').disabled = !chosen().length;
        root.querySelector('[data-profit-selection]').textContent = selectionText();
      }
    });
    root?.addEventListener('click', (event) => {
      if (event.target.closest('[data-profit-add-expense]')) { capture(); const expense = { key: crypto.randomUUID(), description: '', amount: 0, payer: 0 }; draft.expenses.push(expense); root.querySelector('[data-profit-expenses]').insertAdjacentHTML('beforeend', expenseRow(expense)); }
      const remove = event.target.closest('[data-profit-remove-expense]'); if (remove) { remove.closest('[data-profit-expense]').remove(); capture(); }
      if (event.target.closest('[data-profit-next]')) {
        if (!chosen().length) return toast('請選擇要分潤的品項');
        if (zeroCostGroups().length) { state.modal = 'profit-zero-cost'; render(); }
        else enterSettings();
      }
      if (event.target.closest('[data-profit-calculate]')) calculate();
    });
    document.querySelectorAll('[data-profit-back]').forEach((button) => button.addEventListener('click', () => { if (busy) return; capture(); step = button.dataset.profitBack; preview = null; render(); }));
    document.querySelector('[data-profit-finish]')?.addEventListener('click', finish);
    if (state.modal === 'profit-zero-cost') {
      const cancel = () => { state.modal = null; render(); };
      bindBackdropClose(document.querySelector('.modal-backdrop'), cancel);
      document.querySelectorAll('[data-profit-zero-close]').forEach((button) => button.addEventListener('click', cancel));
      document.querySelector('[data-profit-zero-confirm]')?.addEventListener('click', () => {
        const confirmed = new Set([...document.querySelectorAll('[data-profit-zero-product]:checked')].map((input) => input.dataset.profitZeroProduct));
        let removed = false;
        zeroCostGroups().forEach((group) => group.rows.forEach((row) => {
          if (!confirmed.has(row.product.id)) row.items.forEach((item) => { draft.selected.delete(item.id); removed = true; });
        }));
        if (removed) { draft.received = chosenAmount(); draft.receivedConfirmed = false; }
        state.modal = null; enterSettings();
      });
      document.querySelector('[data-profit-zero-product]')?.focus();
    }
    const close = () => { if (busy) return; preview = null; state.modal = null; render(); };
    if (state.modal === 'profit-result') { bindBackdropClose(document.querySelector('.modal-backdrop'), close); document.querySelector('[data-profit-close]')?.addEventListener('click', close); }
  }
  async function restoreWarning(ids) {
    await load();
    const count = ids.filter((id) => settled.has(id)).length;
    return { count, message: count ? `注意：其中 ${count} 個品項已完成分潤。還原後，既有分潤紀錄與金額仍會保留，這些品項不會再次進入待分潤。` : '' };
  }
  function close() { if (busy) return; preview = null; state.modal = null; render(); }
  return { load, panel, modal, bind, restoreWarning, capture, close };
}
