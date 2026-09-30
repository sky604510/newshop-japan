const recipientKey = (name, phone) => `${String(name || '').trim().toLowerCase()}|${String(phone || '').replace(/\D/g, '')}`;

export function createDepositManagement({ state, supabase, esc, money, render, toast, bindBackdropClose }) {
  let ready = false, refunds = [], view = 'received', selected = null, busy = false;

  async function load() {
    if (!state.user || !['admin', 'owner'].includes(state.profile?.role)) { ready = false; refunds = []; return; }
    const { data, error } = await supabase.from('order_deposit_refunds')
      .select('id,batch_id,order_id,order_number,recipient_name,phone,amount,refund_date,refund_source,refund_account,created_at')
      .order('created_at', { ascending: false });
    if (error) {
      ready = false; refunds = [];
      if (/order_deposit_refunds|schema cache|does not exist/i.test(error.message || '')) return;
      throw error;
    }
    ready = true; refunds = data || [];
  }

  function receivedGroups() {
    const returned = new Map();
    refunds.forEach((refund) => returned.set(refund.order_id, (returned.get(refund.order_id) || 0) + Number(refund.amount)));
    const groups = new Map();
    state.orders.forEach((order) => {
      const amount = Number(order.deposit_amount || 0) - (returned.get(order.id) || 0);
      if (amount <= 0) return;
      const key = recipientKey(order.recipient_name, order.phone);
      if (!groups.has(key)) groups.set(key, { key, recipient: order.recipient_name, phone: order.phone || '', orders: [], total: 0 });
      const group = groups.get(key);
      group.orders.push({ id: order.id, number: order.order_number, amount }); group.total += amount;
    });
    return [...groups.values()];
  }

  function panel() {
    const header = `<div class="section-head"><div><span class="eyebrow">DEPOSIT MANAGEMENT</span><h2>訂金管理</h2><p>按收件人彙整訂金來源與退款紀錄；訂金只作備註，不參與訂單或分潤計算。</p></div></div><div class="sub-tabs"><button data-deposit-view="received" class="${view === 'received' ? 'active' : ''}">已收訂金</button><button data-deposit-view="refunded" class="${view === 'refunded' ? 'active' : ''}">已退訂金</button></div>`;
    if (!ready || !state.depositReady) return `<section class="panel">${header}<div class="empty">請先在 Supabase 執行 order_deposit_upgrade.sql 啟用訂金管理。</div></section>`;
    if (view === 'received') return `<section class="panel">${header}<div class="deposit-groups">${receivedGroups().map((group) => `<article class="deposit-group"><div><h3>${esc(group.recipient)}</h3>${group.phone ? `<small>${esc(group.phone)}</small>` : ''}<div class="deposit-sources">${group.orders.map((order) => `<p><span>${esc(order.number)}</span><strong>${money(order.amount)}</strong></p>`).join('')}</div></div><div class="deposit-group-total"><span>訂金來源 ${group.orders.length} 筆</span><strong>總訂金 ${money(group.total)}</strong><button class="btn btn-primary" data-deposit-refund="${esc(group.key)}">退訂</button></div></article>`).join('') || '<div class="empty">目前沒有未退的訂金</div>'}</div></section>`;
    const batches = new Map();
    refunds.forEach((refund) => {
      if (!batches.has(refund.batch_id)) batches.set(refund.batch_id, { ...refund, orders: [], total: 0 });
      const batch = batches.get(refund.batch_id);
      batch.orders.push(refund); batch.total += Number(refund.amount);
    });
    return `<section class="panel">${header}<div class="deposit-groups">${[...batches.values()].map((batch) => `<article class="deposit-group"><div><h3>${esc(batch.recipient_name)}</h3>${batch.phone ? `<small>${esc(batch.phone)}</small>` : ''}<div class="deposit-sources">${batch.orders.map((order) => `<p><span>${esc(order.order_number)}</span><strong>${money(order.amount)}</strong></p>`).join('')}</div></div><div class="deposit-group-total"><strong>已退 ${money(batch.total)}</strong><span>退款日期 ${esc(batch.refund_date)}</span><span>退款來源 ${esc(batch.refund_source)}</span>${batch.refund_account ? `<span>退款帳戶 ${esc(batch.refund_account)}</span>` : ''}</div></article>`).join('') || '<div class="empty">目前沒有退款紀錄</div>'}</div></section>`;
  }

  function modal() {
    if (!selected) return '';
    const date = new Date().toLocaleDateString('sv-SE');
    return `<div class="modal-backdrop"><div class="modal deposit-refund-modal"><div class="modal-head"><div><span class="eyebrow">REFUND DEPOSIT</span><h2>退訂・${esc(selected.recipient)}</h2><p>${selected.orders.length} 筆訂單・剩餘訂金 ${money(selected.total)}</p></div><button class="close" data-deposit-close type="button">×</button></div><div class="field"><label for="deposit-refund-amount">退訂金額（台幣／元）</label><input id="deposit-refund-amount" type="number" inputmode="numeric" min="1" max="${selected.total}" step="1" value="${selected.total}"/></div><div class="field"><label for="deposit-refund-date">退訂日期</label><input id="deposit-refund-date" type="date" value="${date}"/></div><div class="field"><label for="deposit-refund-source">我從哪退訂</label><input id="deposit-refund-source" placeholder="請輸入退款來源"/></div><div class="field"><label for="deposit-refund-account">退款帳戶（選填）</label><input id="deposit-refund-account" placeholder="銀行／帳號或其他資訊"/></div><div class="deposit-refund-actions"><button class="btn btn-light" data-deposit-close type="button">取消</button><button class="btn btn-primary" data-deposit-confirm type="button" ${busy ? 'disabled' : ''}>${busy ? '處理中…' : '確認退款'}</button></div></div></div>`;
  }

  function close() { if (busy) return; selected = null; state.modal = null; render(); }

  async function confirmRefund() {
    if (!selected || busy) return;
    const amountText = document.querySelector('#deposit-refund-amount')?.value || '';
    const amount = Number(amountText), date = document.querySelector('#deposit-refund-date')?.value;
    const source = document.querySelector('#deposit-refund-source')?.value.trim();
    const account = document.querySelector('#deposit-refund-account')?.value.trim() || null;
    if (!amountText || !Number.isSafeInteger(amount) || amount <= 0 || amount > selected.total) { toast('退訂金額須為 1 元以上，且不超過剩餘訂金'); return; }
    if (!date || !source) { toast('請填寫退訂日期與退款來源'); return; }
    busy = true;
    const button = document.querySelector('[data-deposit-confirm]'); if (button) { button.disabled = true; button.textContent = '處理中…'; }
    try {
      const { error } = await supabase.rpc('admin_refund_order_deposits', { p_order_ids: selected.orders.map((order) => order.id), p_amount: amount, p_refund_date: date, p_refund_source: source, p_refund_account: account });
      if (error) throw error;
      await load(); selected = null; state.modal = null; view = 'refunded'; render(); toast('退款紀錄已儲存');
    } catch (error) { toast(error.message || '退款失敗'); }
    finally { busy = false; if (button?.isConnected) { button.disabled = false; button.textContent = '確認退款'; } }
  }

  function bind() {
    document.querySelectorAll('[data-deposit-view]').forEach((button) => button.addEventListener('click', () => { view = button.dataset.depositView; render(); }));
    document.querySelectorAll('[data-deposit-refund]').forEach((button) => button.addEventListener('click', () => {
      selected = receivedGroups().find((group) => group.key === button.dataset.depositRefund) || null;
      if (selected) { state.modal = 'deposit-refund'; render(); }
    }));
    if (state.modal === 'deposit-refund') {
      bindBackdropClose(document.querySelector('.modal-backdrop'), close);
      document.querySelectorAll('[data-deposit-close]').forEach((button) => button.addEventListener('click', close));
      document.querySelector('[data-deposit-confirm]')?.addEventListener('click', confirmRefund);
    }
  }
  return { load, panel, modal, bind, close };
}
