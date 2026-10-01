const cents = (value) => Math.round(Number(value) * 100);

export function calculateProfitShare(items, settings) {
  const parties = settings.parties.map((party) => ({ ...party, advance: 0, share: 0, balance: 0 }));
  if (parties.length !== 2 || parties.some((party) => !party.name.trim() || !Number.isFinite(Number(party.ratio)) || party.ratio < 0) || parties[0].name.trim() === parties[1].name.trim() || Math.abs(Number(parties[0].ratio) + Number(parties[1].ratio) - 100) > 0.00001) throw new Error('請填寫兩位不同的分潤人，比例合計須為 100%');
  if (![0, 1].includes(settings.collector) || !Number.isFinite(settings.received) || settings.received < 0 || !settings.receivedConfirmed) throw new Error('請確認收帳人、實際入帳金額，並勾選已確認入帳');
  let revenue = 0, itemCost = 0, extraCost = 0;
  for (const item of items) {
    const payer = settings.payers[item.id];
    if (![0, 1].includes(payer)) throw new Error('請指定商品成本付款人');
    const cost = cents(item.unit_cost * item.quantity);
    itemCost += cost; revenue += cents(item.unit_price * item.quantity); parties[payer].advance += cost;
  }
  for (const expense of settings.expenses) {
    if (!expense.description.trim() || !Number.isFinite(expense.amount) || expense.amount < 0 || ![0, 1].includes(expense.payer)) throw new Error('請填寫額外成本用途、金額與付款人');
    const cost = cents(expense.amount); extraCost += cost; parties[expense.payer].advance += cost;
  }
  const received = cents(settings.received), profit = received - itemCost - extraCost;
  parties[0].share = Math.floor(profit * Number(parties[0].ratio) / 100 + 0.5);
  parties[1].share = profit - parties[0].share;
  parties.forEach((party, index) => { party.balance = party.advance + party.share - (index === settings.collector ? received : 0); });
  return { revenue: revenue / 100, received: received / 100, item_cost: itemCost / 100, extra_cost: extraCost / 100, profit: profit / 100, collector: settings.collector, parties: parties.map((party) => ({ ...party, advance: party.advance / 100, share: party.share / 100, balance: party.balance / 100 })), expenses: settings.expenses.map((expense) => ({ ...expense, amount: cents(expense.amount) / 100 })), items: items.map((item) => ({ ...item, payer: settings.payers[item.id] })) };
}

export function completedProfitItems(orders, fulfillments, settled, getCost, getDeduction = () => 0) {
  return orders.filter((order) => order.status !== 'cancelled').flatMap((order) => (order.order_items || []).filter((item) => {
    const record = fulfillments.get(item.id);
    return record?.shipped_at && record?.completed_at && !settled.has(item.id);
  }).map((item) => ({ id: item.id, order_id: order.id, order_number: order.order_number, recipient: order.recipient_name, name: item.product_name, quantity: Number(item.quantity), unit_price: Number(item.unit_price), unit_cost: getCost(item), product_id: item.product_id, deduction: getDeduction(order, item) })));
}

export function createProfitSharing({ state, supabase, esc, money, getCost, getDeduction = () => 0, render, toast, reload, bindBackdropClose }) {
  let stickyObserver, configurationOpen;
  let ready = false, settlements = [], settled = new Set(), view = 'pending', draft = null, preview = null, busy = false;
  const pending = () => completedProfitItems(state.orders, state.fulfillmentChecks, settled, getCost, getDeduction).map((item) => ({ ...item, image_url: (state.products || []).find((product) => product.id === item.product_id)?.image_url || '' }));
  const freshDraft = () => ({ selected: new Set(), title: '', parties: [{ name: '我', ratio: 50 }, { name: '老婆', ratio: 50 }], collector: 0, received: '', receivedConfirmed: false, payers: {}, expenses: [] });
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
    draft.title = root.querySelector('[data-profit-title]').value;
    draft.parties = [...root.querySelectorAll('[data-profit-party]')].map((row) => ({ name: row.querySelector('[data-profit-name]').value, ratio: Number(row.querySelector('[data-profit-ratio]').value) }));
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
    const receiver = result.parties.find((party) => party.balance > 0), sender = result.parties.find((party) => party.balance < 0);
    const extraCosts = result.expenses.length ? `<h3>額外成本</h3>${result.expenses.map((expense) => `<p>${esc(expense.description)}・${money(expense.amount)}・${esc(result.parties[expense.payer].name)} 付款</p>`).join('')}` : '';
    return `<div class="profit-totals"><p>商品銷售金額<strong>${money(result.revenue)}</strong></p><p>實際入帳<strong>${money(result.received)}</strong></p><p>商品成本<strong>${money(result.item_cost)}</strong></p><p>額外成本<strong>${money(result.extra_cost)}</strong></p><p>可分${result.profit < 0 ? '虧損' : '利潤'}<strong>${money(result.profit)}</strong></p></div><div class="profit-party-results">${result.parties.map((party, index) => `<article><strong>${esc(party.name)}（${party.ratio}%）${index === result.collector ? '・收帳人' : ''}</strong><p>代墊款 ${money(party.advance)}</p><p>分得${party.share < 0 ? '虧損' : '利潤'} ${money(party.share)}</p><p>應${party.balance < 0 ? '轉出' : '收取'} ${money(Math.abs(party.balance))}</p></article>`).join('')}</div><div class="profit-transfer">${receiver && sender ? `${esc(sender.name)} 應轉給 ${esc(receiver.name)} ${money(receiver.balance)}` : '本次不需互相轉帳'}</div>${extraCosts}<details><summary>本次訂單品項（${result.items.length} 項）</summary>${result.items.map((item) => `<div class="profit-result-item">${itemThumbnail(item)}<p>${esc(item.order_number)}・${esc(item.recipient)}・${esc(item.name)} × ${item.quantity}<br/><small>售價 ${money(item.unit_price)}・成本 ${money(item.unit_cost)}・${esc(result.parties[item.payer].name)} 付款</small></p></div>`).join('')}</details>`;
  }
  function panel() {
    if (!draft) draft = freshDraft();
    const header = `<div class="section-head"><div><span class="eyebrow">PROFIT SHARING</span><h2>分潤清單</h2><p>只結算發貨清單「已完成」且尚未分潤的品項。</p></div></div><div class="sub-tabs"><button data-profit-view="pending" class="${view === 'pending' ? 'active' : ''}">待分潤</button><button data-profit-view="settled" class="${view === 'settled' ? 'active' : ''}">已分潤</button></div>`;
    if (!ready) return `<section class="panel">${header}<div class="empty">分潤功能尚未啟用，請先執行 profit_sharing_upgrade.sql。</div></section>`;
    if (view === 'settled') return `<section class="panel">${header}${settlements.map((entry) => `<article class="profit-history"><div><strong>${esc(entry.snapshot.title || '分潤批次')}</strong><p>分潤時間：${new Date(entry.completed_at).toLocaleString('zh-TW')}</p><p>${entry.snapshot.items.length} 個品項・入帳 ${money(entry.snapshot.received)}・利潤 ${money(entry.snapshot.profit)}</p>${entry.snapshot.items.some((item) => state.orders.some((order) => (order.order_items || []).some((row) => row.id === item.id)) && !state.fulfillmentChecks.get(item.id)?.completed_at) ? '<p class="profit-warning">部分品項已從「已完成」還原；本批分潤紀錄仍保留。</p>' : ''}</div><button class="btn btn-light" data-profit-history="${entry.id}">查看結果</button></article>`).join('') || '<div class="empty">尚無已分潤紀錄</div>'}</section>`;
    const groups = new Map(); pending().forEach((item) => { if (!groups.has(item.order_id)) groups.set(item.order_id, []); groups.get(item.order_id).push(item); });
    return `<section class="panel">${header}<div data-profit-form><div class="profit-controls"><div class="profit-controls-body"><details class="profit-configuration" open><summary>分潤設定</summary><div class="profit-settings"><label>批次名稱<input data-profit-title value="${esc(draft.title)}" placeholder="例如：9 月第一批分潤"/></label>${draft.parties.map((party, index) => `<div class="profit-party" data-profit-party><label>分潤人 ${index + 1}<input data-profit-name value="${esc(party.name)}"/></label><label>比例（%）<input data-profit-ratio type="number" min="0" max="100" step="0.01" value="${party.ratio}"/></label></div>`).join('')}<label>收帳人<select data-profit-collector>${options(draft.collector)}</select></label></div></details><div class="section-head"><h3>額外成本</h3><button class="btn btn-light" type="button" data-profit-add-expense>＋ 新增成本</button></div><div data-profit-expenses>${draft.expenses.map(expenseRow).join('')}</div></div><div class="profit-income"><label>本批實際入帳金額<input data-profit-received type="number" min="0" step="0.01" value="${esc(draft.received === '' ? chosenAmount() : draft.received)}"/></label><label class="inline-check"><input data-profit-confirmed type="checkbox" ${draft.receivedConfirmed ? 'checked' : ''}/> 已確認本批貨款入帳</label><small data-profit-selection>已選 ${chosen().length} 個品項・商品銷售合計 ${money(chosenAmount())}</small><button class="btn btn-primary" type="button" data-profit-calculate>計算分潤</button></div></div><div class="profit-order-list">${[...groups.values()].map((items) => `<article class="profit-order"><header><label><input type="checkbox" data-profit-order="${items[0].order_id}" ${items.every((item) => draft.selected.has(item.id)) ? 'checked' : ''}/> ${esc(items[0].order_number)}・${esc(items[0].recipient)}</label><strong>${money(items.reduce((sum, item) => sum + cents(item.unit_price * item.quantity), 0) / 100)}</strong></header>${items.map((item) => `<div class="profit-item"><label><input type="checkbox" data-profit-item="${item.id}" ${draft.selected.has(item.id) ? 'checked' : ''}/>${itemThumbnail(item)}<span>${esc(item.name)} × ${item.quantity}<small>售價 ${money(item.unit_price)}・成本 ${money(item.unit_cost)}</small></span></label><label>成本付款人<select data-profit-payer="${item.id}">${options(draft.payers[item.id] ?? 0)}</select></label></div>`).join('')}</article>`).join('') || '<div class="empty">目前沒有已完成且尚未分潤的品項</div>'}</div></div></section>`;
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
      preview = { result, settings }; state.modal = 'profit-result'; render();
    } catch (error) { toast(error.message); }
  }
  async function finish() {
    if (busy || !preview || preview.id) return;
    busy = true; const button = document.querySelector('[data-profit-finish]'); if (button) { button.disabled = true; button.textContent = '儲存中…'; }
    try {
      const { data, error } = await supabase.rpc('admin_complete_profit_share', { p_item_ids: preview.result.items.map((item) => item.id), p_settings: { ...preview.settings, selected: undefined, expected_items: preview.result.items } });
      if (error) throw error;
      const record = Array.isArray(data) ? data[0] : data;
      if (!record?.snapshot?.items) throw new Error('分潤結果回傳異常，請重新載入已分潤清單確認');
      settlements.unshift(record); settled = new Set([...settled, ...record.snapshot.items.map((item) => item.id)]);
      draft = freshDraft(); preview = null; state.modal = null; view = 'settled'; render(); toast('分潤完成，已保存結算結果與時間');
    } catch (error) {
      const messages = { INVALID_PROFIT_SETTINGS: '請確認入帳金額、分潤比例與成本付款人', PROFIT_ITEM_STATE_CHANGED: '部分品項已不在「已完成」，請重新選取', PROFIT_ITEM_ALREADY_SETTLED: '部分品項已分潤，請重新選取', PROFIT_ITEM_AMOUNT_CHANGED: '訂單金額或成本已變更，請重新計算' };
      toast(messages[error.message] || error.message);
      if (/PROFIT_ITEM_/.test(error.message)) {
        try { await reload(); await load(); preview = null; state.modal = null; render(); }
        catch (refreshError) { toast(`重新載入失敗：${refreshError.message}`); }
      }
    } finally { busy = false; if (button?.isConnected) { button.disabled = false; button.textContent = '分潤完成'; } }
  }
  function bind() {
    document.querySelectorAll('[data-profit-view]').forEach((button) => button.addEventListener('click', () => { capture(); view = button.dataset.profitView; render(); }));
    document.querySelectorAll('[data-profit-history]').forEach((button) => button.addEventListener('click', () => { const entry = settlements.find((row) => row.id === button.dataset.profitHistory); preview = { id: entry.id, completed_at: entry.completed_at, result: entry.snapshot }; state.modal = 'profit-result'; render(); }));
    const root = document.querySelector('[data-profit-form]');
    stickyObserver?.disconnect();
    if (root) {
      const configuration = root.querySelector('.profit-configuration');
      configurationOpen ??= !matchMedia('(max-width:820px)').matches;
      configuration.open = configurationOpen;
      configuration.addEventListener('toggle', () => { configurationOpen = configuration.open; });
      const tabs = document.querySelector('.admin-tabs');
      const updateOffset = () => root.style.setProperty('--profit-sticky-top', `${tabs ? parseFloat(getComputedStyle(tabs).top) + tabs.getBoundingClientRect().height + 10 : 12}px`);
      updateOffset();
      if (tabs) { stickyObserver = new ResizeObserver(updateOffset); stickyObserver.observe(tabs); }
    }
    root?.addEventListener('input', capture);
    root?.addEventListener('change', (event) => {
      const input = event.target; capture();
      if (input.matches('[data-profit-name]')) root.querySelectorAll('[data-profit-collector],[data-profit-payer],[data-profit-expense-payer]').forEach((select) => { select.innerHTML = options(Number(select.value)); });
      if (input.matches('[data-profit-item],[data-profit-order]')) {
        const ids = input.matches('[data-profit-item]') ? [input.dataset.profitItem] : pending().filter((item) => item.order_id === input.dataset.profitOrder).map((item) => item.id);
        ids.forEach((id) => { if (input.checked) draft.selected.add(id); else draft.selected.delete(id); });
        root.querySelectorAll('[data-profit-item]').forEach((check) => { check.checked = draft.selected.has(check.dataset.profitItem); });
        root.querySelectorAll('[data-profit-order]').forEach((check) => { const items = pending().filter((item) => item.order_id === check.dataset.profitOrder); check.checked = items.every((item) => draft.selected.has(item.id)); check.indeterminate = !check.checked && items.some((item) => draft.selected.has(item.id)); });
        draft.received = chosenAmount(); draft.receivedConfirmed = false;
        root.querySelector('[data-profit-received]').value = draft.received; root.querySelector('[data-profit-confirmed]').checked = false;
        root.querySelector('[data-profit-selection]').textContent = `已選 ${chosen().length} 個品項・商品銷售合計 ${money(chosenAmount())}`;
      }
    });
    root?.addEventListener('click', (event) => {
      if (event.target.closest('[data-profit-add-expense]')) { capture(); const expense = { key: crypto.randomUUID(), description: '', amount: 0, payer: 0 }; draft.expenses.push(expense); root.querySelector('[data-profit-expenses]').insertAdjacentHTML('beforeend', expenseRow(expense)); }
      const remove = event.target.closest('[data-profit-remove-expense]'); if (remove) { remove.closest('[data-profit-expense]').remove(); capture(); }
      if (event.target.closest('[data-profit-calculate]')) calculate();
    });
    const close = () => { if (busy) return; preview = null; state.modal = null; render(); };
    if (state.modal === 'profit-result') { bindBackdropClose(document.querySelector('.modal-backdrop'), close); document.querySelector('[data-profit-close]')?.addEventListener('click', close); document.querySelector('[data-profit-finish]')?.addEventListener('click', finish); }
  }
  async function restoreWarning(ids) {
    await load();
    const count = ids.filter((id) => settled.has(id)).length;
    return { count, message: count ? `注意：其中 ${count} 個品項已完成分潤。還原後，既有分潤紀錄與金額仍會保留，這些品項不會再次進入待分潤。` : '' };
  }
  function close() { if (busy) return; preview = null; state.modal = null; render(); }
  return { load, panel, modal, bind, restoreWarning, capture, close };
}
