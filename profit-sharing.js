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
    itemCost += cost; revenue += cents(item.unit_price * item.quantity); parties[payer].advance += cost;
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
  return { revenue: revenue / 100, received: received / 100, item_cost: itemCost / 100, extra_cost: extraCost / 100, profit: profit / 100, collector: settings.collector, parties: parties.map((party) => ({ ...party, advance: party.advance / 100, share: party.share / 100, balance: party.balance / 100 })), expenses: settings.expenses.map((expense) => ({ ...expense, amount: cents(expense.amount) / 100 })), items: items.map((item) => ({ ...item, payer: settings.payers[item.id] })) };
}

export function procuredProfitItems(orders, procurementChecks, settled, getCost, getDeduction = () => 0) {
  return orders.filter((order) => order.status !== 'cancelled').flatMap((order) => (order.order_items || []).filter((item) => {
    return Boolean(item.product_id && procurementChecks.get(item.product_id)?.is_purchased) && !settled.has(item.id);
  }).map((item) => ({ id: item.id, order_id: order.id, order_number: order.order_number, recipient: order.recipient_name, name: item.product_name, quantity: Number(item.quantity), unit_price: Number(item.unit_price), unit_cost: getCost(item), product_id: item.product_id, deduction: getDeduction(order, item) })));
}

export function createProfitSharing({ state, supabase, esc, money, getCost, getDeduction = () => 0, render, toast, reload, bindBackdropClose }) {
  let step = 'select';
  let stickyObserver;
  let ready = false, settlements = [], settled = new Set(), view = 'pending', draft = null, preview = null, busy = false;
  const pending = () => procuredProfitItems(state.orders, state.procurementChecks, settled, getCost, getDeduction).map((item) => ({ ...item, image_url: (state.products || []).find((product) => product.id === item.product_id)?.image_url || '' }));
  const freshDraft = () => ({ selected: new Set(), title: '', parties: [{ name: '分潤人1', ratio: 100 }], collector: 0, received: '', receivedConfirmed: false, payers: {}, expenses: [] });
  const options = (selected) => draft.parties.map((party, index) => `<option value="${index}" ${index === selected ? 'selected' : ''}>${esc(party.name || `分潤人 ${index + 1}`)}</option>`).join('');
  const chosen = () => pending().filter((item) => draft?.selected.has(item.id));
  const chosenAmount = () => chosen().reduce((sum, item) => sum + cents(item.unit_price * item.quantity - item.deduction), 0) / 100;
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
    draft.parties = [...root.querySelectorAll('[data-profit-party]')].map((row) => ({ name: row.querySelector('[data-profit-name]').value, ratio: row.querySelector('[data-profit-ratio]').value === '' ? NaN : Number(row.querySelector('[data-profit-ratio]').value) }));
    draft.collector = Number(root.querySelector('[data-profit-collector]').value);
    draft.received = root.querySelector('[data-profit-received]').value;
    draft.receivedConfirmed = root.querySelector('[data-profit-confirmed]').checked;
    root.querySelectorAll('[data-profit-payer]').forEach((select) => { draft.payers[select.dataset.profitPayer] = Number(select.value); });
    draft.expenses = [...root.querySelectorAll('[data-profit-expense]')].map((row) => ({ key: row.dataset.profitExpense, description: row.querySelector('[data-profit-expense-name]').value, amount: Number(row.querySelector('[data-profit-expense-amount]').value), payer: Number(row.querySelector('[data-profit-expense-payer]').value) }));
  }
  function expenseRow(expense) {
    return `<div class="profit-expense" data-profit-expense="${expense.key}"><label>用途<input data-profit-expense-name value="${esc(expense.description)}" placeholder="集運費、包材…"/></label><label>金額<input data-profit-expense-amount type="number" min="0" step="0.01" value="${expense.amount}"/></label><label>付款人<select data-profit-expense-payer>${options(expense.payer)}</select></label><button class="btn btn-danger-soft" type="button" data-profit-remove-expense="${expense.key}">移除</button></div>`;
  }
  function itemThumbnail(item) {
    const productId = item.product_id || state.orders.flatMap((order) => order.order_items || []).find((row) => row.id === item.id)?.product_id;
    const url = item.image_url || (state.products || []).find((product) => product.id === productId)?.image_url;
    return `<span class="profit-item-thumb">${url ? `<img src="${esc(url)}" alt="" loading="lazy"/>` : '<span aria-hidden="true">無圖片</span>'}</span>`;
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
    return `<div class="profit-totals"><p>商品銷售金額<strong>${money(result.revenue)}</strong></p><p>實際入帳<strong>${money(result.received)}</strong></p><p>商品成本<strong>${money(result.item_cost)}</strong></p><p>額外成本<strong>${money(result.extra_cost)}</strong></p><p>可分${result.profit < 0 ? '虧損' : '利潤'}<strong>${money(result.profit)}</strong></p></div><div class="profit-party-results">${result.parties.map((party, index) => `<article><strong>${esc(party.name)}（${party.ratio}%）${index === result.collector ? '・收帳人' : ''}</strong><p>代墊款 ${money(party.advance)}</p><p>分得${party.share < 0 ? '虧損' : '利潤'} ${money(party.share)}</p><p>應${party.balance < 0 ? '轉出' : '收取'} ${money(Math.abs(party.balance))}</p></article>`).join('')}</div><div class="profit-transfer">${transfers.length ? transfers.join('<br/>') : '本次不需互相轉帳'}</div>${extraCosts}<section class="profit-result-items"><h3>本次訂單品項（${result.items.length} 項）</h3>${result.items.map((item) => `<div class="profit-result-item">${itemThumbnail(item)}<p>${esc(item.order_number)}・${esc(item.recipient)}・${esc(item.name)} × ${item.quantity}<br/><small>售價 ${money(item.unit_price)}・成本 ${money(item.unit_cost)}・${esc(result.parties[item.payer].name)} 付款</small></p></div>`).join('')}</section>`;
  }
  function orderList(items, selectable = false) {
    const groups = new Map(); items.forEach((item) => { if (!groups.has(item.order_id)) groups.set(item.order_id, []); groups.get(item.order_id).push(item); });
    return `<div class="profit-order-list">${[...groups.values()].map((rows) => `<article class="profit-order"><header><label>${selectable ? `<input type="checkbox" data-profit-order="${rows[0].order_id}" ${rows.every((item) => draft.selected.has(item.id)) ? 'checked' : ''}/>` : ''}${esc(rows[0].order_number)}・${esc(rows[0].recipient)}</label><strong>${money(rows.reduce((sum, item) => sum + cents(item.unit_price * item.quantity - item.deduction), 0) / 100)}</strong></header>${rows.map((item) => `<div class="profit-item ${selectable ? 'profit-select-item' : ''}"><label>${selectable ? `<input type="checkbox" data-profit-item="${item.id}" ${draft.selected.has(item.id) ? 'checked' : ''}/>` : ''}${itemThumbnail(item)}<span>${esc(item.name)} × ${item.quantity}<small>售價 ${money(item.unit_price)}・成本 ${money(item.unit_cost)}${item.deduction ? `・內扣 ${money(item.deduction)}` : ''}</small></span></label>${selectable ? '' : `<label>成本付款人<select data-profit-payer="${item.id}">${options(draft.payers[item.id] ?? 0)}</select></label>`}</div>`).join('')}</article>`).join('') || '<div class="empty">目前沒有採購完成且尚未分潤的品項</div>'}</div>`;
  }
  function partyTable() {
    return `<div class="section-head"><h3>分潤人</h3><button type="button" class="btn btn-light" data-profit-add-party>＋ 添加分潤人</button></div><div class="table-wrap"><table class="admin-table profit-party-table"><thead><tr><th>分潤人名稱</th><th>比例（%）</th><th>操作</th></tr></thead><tbody>${draft.parties.map((party, index) => `<tr data-profit-party><td><input data-profit-name aria-label="分潤人 ${index + 1} 名稱" value="${esc(party.name)}"/></td><td><input data-profit-ratio aria-label="分潤人 ${index + 1} 比例" type="number" min="0" max="100" step="1" value="${Number.isFinite(party.ratio) ? party.ratio : ''}"/></td><td><button class="btn btn-danger-soft" type="button" data-profit-remove-party="${index}" ${draft.parties.length === 1 ? 'disabled' : ''}>移除</button></td></tr>`).join('')}</tbody></table></div><p data-profit-ratio-total class="draft-hint">比例合計：${draft.parties.reduce((sum, party) => sum + party.ratio, 0)}%（須為 100%，不使用小數）</p>`;
  }
  function panel() {
    if (!draft) draft = freshDraft();
    const header = `<div class="section-head"><div><span class="eyebrow">PROFIT SHARING</span><h2>分潤清單</h2><p>只結算採購歷史中尚未分潤的訂單品項，不受發貨狀態限制。</p></div></div><div class="sub-tabs"><button data-profit-view="pending" class="${view === 'pending' ? 'active' : ''}">待分潤</button><button data-profit-view="settled" class="${view === 'settled' ? 'active' : ''}">已分潤</button></div>`;
    if (!ready) return `<section class="panel">${header}<div class="empty">分潤功能尚未啟用，請先執行 profit_sharing_upgrade.sql。</div></section>`;
    if (view === 'settled') return `<section class="panel">${header}${settlements.map((entry) => `<article class="profit-history"><div><strong>${esc(entry.snapshot.title || '分潤批次')}</strong><p>分潤時間：${new Date(entry.completed_at).toLocaleString('zh-TW')}</p><p>${entry.snapshot.items.length} 個品項・入帳 ${money(entry.snapshot.received)}・利潤 ${money(entry.snapshot.profit)}</p>${entry.snapshot.items.some((item) => state.orders.some((order) => (order.order_items || []).some((row) => row.id === item.id)) && !state.procurementChecks.get(item.product_id || state.orders.flatMap((order) => order.order_items || []).find((row) => row.id === item.id)?.product_id)?.is_purchased) ? '<p class="profit-warning">部分品項已移回待採購；本批分潤紀錄仍保留。</p>' : ''}</div><button class="btn btn-light" data-profit-history="${entry.id}">查看結果</button></article>`).join('') || '<div class="empty">尚無已分潤紀錄</div>'}</section>`;
    const steps = `<ol class="profit-steps" aria-label="分潤步驟">${['選擇商品', '分潤設定', '結果確認'].map((label, index) => `<li class="${['select', 'settings', 'result'].indexOf(step) === index ? 'active' : ''}"><span>${index + 1}</span>${label}</li>`).join('')}</ol>`;
    if (step === 'result' && preview && !preview.id) return `<section class="panel">${header}${steps}<h3>${esc(preview.result.title || '分潤結果')}</h3>${resultHtml(preview.result)}<div class="profit-step-actions"><button class="btn btn-light" data-profit-back="settings" ${busy ? 'disabled' : ''}>返回設定</button><button class="btn btn-primary" data-profit-finish ${busy ? 'disabled' : ''}>${busy ? '儲存中…' : '分潤完成'}</button></div><p class="draft-hint">確認轉帳完成後，再按「分潤完成」保存帳目與時間。</p></section>`;
    if (step === 'select') return `<section class="panel">${header}${steps}<div data-profit-form><div class="profit-selection-bar"><strong data-profit-selection>已選 ${chosen().length} 個品項・商品銷售合計 ${money(chosenAmount())}</strong><button class="btn btn-primary" data-profit-next ${chosen().length ? '' : 'disabled'}>下一步 →</button></div>${orderList(pending(), true)}</div></section>`;
    return `<section class="panel">${header}${steps}<div data-profit-form><div class="profit-settings"><label>分潤名稱<input data-profit-title value="${esc(draft.title)}" placeholder="例如：10 月第一批分潤"/></label><label>收帳人<select data-profit-collector>${options(draft.collector)}</select></label></div>${partyTable()}<h3 class="profit-block-title">已選商品與成本付款人</h3>${orderList(chosen())}<div class="section-head"><h3>額外成本</h3><button class="btn btn-light" type="button" data-profit-add-expense>＋ 新增成本</button></div><div data-profit-expenses>${draft.expenses.map(expenseRow).join('')}</div><div class="profit-income"><label>本批實際入帳金額<input data-profit-received type="number" min="0" step="0.01" value="${esc(draft.received === '' ? chosenAmount() : draft.received)}"/></label><label class="inline-check"><input data-profit-confirmed type="checkbox" ${draft.receivedConfirmed ? 'checked' : ''}/> 已確認本批貨款入帳</label></div><div class="profit-step-actions"><button class="btn btn-light" type="button" data-profit-back="select">← 返回選商品</button><button class="btn btn-primary" type="button" data-profit-calculate>計算分潤 →</button></div></div></section>`;
  }
  function modal() {
    if (!preview) return '';
    return `<div class="modal-backdrop"><div class="modal profit-result-modal"><div class="modal-head"><h2>${esc(preview.result.title || '分潤結果')}</h2><button class="close" data-profit-close>×</button></div>${preview.completed_at ? `<p>分潤時間：${new Date(preview.completed_at).toLocaleString('zh-TW')}</p>` : ''}${resultHtml(preview.result)}${preview.id ? '' : '<p>確認轉帳完成後，按下「分潤完成」保存本次帳目。</p><button class="btn btn-primary" data-profit-finish>分潤完成</button>'}</div></div>`;
  }
  async function calculate() {
    capture();
    try {
      const items = chosen(); if (!items.length) throw new Error('請選擇要分潤的品項');
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
      const { data, error } = await supabase.rpc('admin_complete_procurement_profit_share', { p_item_ids: preview.result.items.map((item) => item.id), p_settings: { ...preview.settings, selected: undefined, expected_items: preview.result.items } });
      if (error) throw error;
      const record = Array.isArray(data) ? data[0] : data;
      if (!record?.snapshot?.items) throw new Error('分潤結果回傳異常，請重新載入已分潤清單確認');
      settlements.unshift(record); settled = new Set([...settled, ...record.snapshot.items.map((item) => item.id)]);
      draft = freshDraft(); step = 'select'; preview = null; state.modal = null; view = 'settled'; render(); toast('分潤完成，已保存結算結果與時間');
    } catch (error) {
      const messages = { INVALID_PROFIT_SETTINGS: '請確認入帳金額、分潤比例與成本付款人', PROFIT_ITEM_STATE_CHANGED: '部分品項已不在採購歷史，請重新選取', PROFIT_ITEM_ALREADY_SETTLED: '部分品項已分潤，請重新選取', PROFIT_ITEM_AMOUNT_CHANGED: '訂單金額或成本已變更，請重新計算' };
      toast(/admin_complete_procurement_profit_share|schema cache/i.test(error.message || '') ? '請先執行 profit_sharing_procurement_upgrade.sql，啟用採購歷史分潤' : messages[error.message] || error.message);
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
      if (input.matches('[data-profit-name]')) root.querySelectorAll('[data-profit-collector],[data-profit-payer],[data-profit-expense-payer]').forEach((select) => { select.innerHTML = options(Number(select.value)); });
      if (input.matches('[data-profit-item],[data-profit-order]')) {
        const ids = input.matches('[data-profit-item]') ? [input.dataset.profitItem] : pending().filter((item) => item.order_id === input.dataset.profitOrder).map((item) => item.id);
        ids.forEach((id) => { if (input.checked) draft.selected.add(id); else draft.selected.delete(id); });
        root.querySelectorAll('[data-profit-item]').forEach((check) => { check.checked = draft.selected.has(check.dataset.profitItem); });
        root.querySelectorAll('[data-profit-order]').forEach((check) => { const items = pending().filter((item) => item.order_id === check.dataset.profitOrder); check.checked = items.every((item) => draft.selected.has(item.id)); check.indeterminate = !check.checked && items.some((item) => draft.selected.has(item.id)); });
        draft.received = chosenAmount(); draft.receivedConfirmed = false;
        root.querySelector('[data-profit-next]').disabled = !chosen().length;
        root.querySelector('[data-profit-selection]').textContent = `已選 ${chosen().length} 個品項・商品銷售合計 ${money(chosenAmount())}`;
      }
    });
    root?.addEventListener('click', (event) => {
      if (event.target.closest('[data-profit-add-expense]')) { capture(); const expense = { key: crypto.randomUUID(), description: '', amount: 0, payer: 0 }; draft.expenses.push(expense); root.querySelector('[data-profit-expenses]').insertAdjacentHTML('beforeend', expenseRow(expense)); }
      const remove = event.target.closest('[data-profit-remove-expense]'); if (remove) { remove.closest('[data-profit-expense]').remove(); capture(); }
      if (event.target.closest('[data-profit-next]')) {
        if (!chosen().length) return toast('請選擇要分潤的品項');
        chosen().forEach((item) => { draft.payers[item.id] ??= 0; });
        step = 'settings'; render();
      }
      if (event.target.closest('[data-profit-add-party]')) {
        capture(); let number = draft.parties.length + 1;
        while (draft.parties.some((party) => party.name === `分潤人${number}`)) number++;
        draft.parties.push({ name: `分潤人${number}`, ratio: 0 });
        const ratios = equalProfitRatios(draft.parties.length);
        draft.parties.forEach((party, index) => { party.ratio = ratios[index]; }); render();
      }
      const removeParty = event.target.closest('[data-profit-remove-party]');
      if (removeParty && draft.parties.length > 1) {
        capture(); const index = Number(removeParty.dataset.profitRemoveParty); draft.parties.splice(index, 1);
        const remap = (value) => value === index ? 0 : value > index ? value - 1 : value;
        draft.collector = remap(draft.collector);
        Object.keys(draft.payers).forEach((id) => { draft.payers[id] = remap(draft.payers[id]); });
        draft.expenses.forEach((expense) => { expense.payer = remap(expense.payer); });
        const ratios = equalProfitRatios(draft.parties.length);
        draft.parties.forEach((party, position) => { party.ratio = ratios[position]; }); render();
      }
      if (event.target.closest('[data-profit-calculate]')) calculate();
    });
    document.querySelectorAll('[data-profit-back]').forEach((button) => button.addEventListener('click', () => { if (busy) return; capture(); step = button.dataset.profitBack; preview = null; render(); }));
    document.querySelector('[data-profit-finish]')?.addEventListener('click', finish);
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
