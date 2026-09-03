import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabase = createClient(
  'https://qikmnuchhfmkseoenawr.supabase.co',
  'sb_publishable_EGSzGcTPs8krwlf7H7TsMA_mVc7wk83',
  { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } },
);

const statusLabels = { pending: '待確認', confirmed: '已確認', preparing: '已採購', shipped: '已出貨', completed: '已完成', cancelled: '已取消' };
const deliveryOptions = ['面交取貨', '宅配到府', '7-ELEVEN 貨到付款'];
const managerRoles = new Set(['admin', 'owner']);
const state = {
  view: 'shop', cart: JSON.parse(localStorage.getItem('newshop_cart') || '[]'),
  user: null, profile: null, markets: [], products: [], orders: [], customers: [], modal: null,
  selectedMarketId: null, selectedProductId: null, detailQty: 1,
  marketDraft: null, editingMarketId: null, lastOrder: null,
  customerDraft: null, checkoutMode: 'general',
  checkoutDraft: JSON.parse(localStorage.getItem('newshop_checkout_draft') || '{}'),
  authMode: 'login', adminTab: 'markets', adminOrderHistory: false, procurementHistory: false,
  procurementChecks: new Map(), loading: true, busy: false, toast: '', marketFeatureReady: true,
  operationsReady: true, costReady: true, pricingReady: true, adminOpsReady: true, sortingReady: true,
};

const money = (value) => `NT$ ${Number(value || 0).toLocaleString('zh-TW')}`;
const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
const saveCart = () => localStorage.setItem('newshop_cart', JSON.stringify(state.cart));
const cartCount = () => state.cart.reduce((sum, item) => sum + item.qty, 0);
const cartTotal = () => state.cart.reduce((sum, item) => sum + Number(item.price) * item.qty, 0);
const isManager = () => managerRoles.has(state.profile?.role);
const saveCheckoutDraft = () => localStorage.setItem('newshop_checkout_draft', JSON.stringify(state.checkoutDraft));
const dateValue = (value) => value ? new Date(value).toLocaleDateString('en-CA') : '';
const isClosed = (market) => Boolean(market?.closes_at && new Date(market.closes_at) < new Date());
const deliverySelect = (selected = '面交取貨') => deliveryOptions.map((option) => `<option value="${esc(option)}" ${option === selected ? 'selected' : ''}>${esc(option)}</option>`).join('');
let toastTimer = null;
let toastElement = null;

function renderToast(message) {
  state.toast = message;
  if (!toastElement?.isConnected) {
    document.querySelectorAll('.toast').forEach((toast) => toast.remove());
    toastElement = document.createElement('div'); toastElement.className = 'toast'; document.body.appendChild(toastElement);
  }
  toastElement.textContent = message;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    state.toast = ''; toastElement?.remove(); toastElement = null; toastTimer = null;
  }, 2600);
}

function friendlyError(error) {
  const message = error?.message || String(error || '發生未知錯誤');
  if (/invalid login credentials/i.test(message)) return '信箱或密碼錯誤';
  if (/user already registered/i.test(message)) return '這個信箱已經註冊';
  if (/email not confirmed/i.test(message)) return '請先到信箱完成驗證';
  if (/insufficient_stock/i.test(message)) return `商品庫存不足：${message.split(':').slice(1).join(':').trim()}`;
  if (/product_not_available/i.test(message)) return '部分品項已下架，請重新整理購物車';
  if (/login_required/i.test(message)) return '請先登入會員';
  return message;
}

function normalizeMarkets(markets) {
  return (markets || []).map((market, marketIndex) => ({
    ...market,
    is_pinned: Boolean(market.is_pinned),
    products: (market.products || []).sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0) || new Date(a.created_at) - new Date(b.created_at)),
    emoji: ['🎀', '🌸', '🍭', '🪞', '💝'][marketIndex % 5],
  })).sort((a, b) => Number(Boolean(b.is_pinned)) - Number(Boolean(a.is_pinned)) || Number(a.sort_order || 0) - Number(b.sort_order || 0) || new Date(b.created_at) - new Date(a.created_at));
}

function syncCartWithProducts() {
  state.products = state.markets.flatMap((market) => market.products.map((product) => ({ ...product, market_id: market.id, market_name: market.name })));
  state.cart = state.cart.map((item) => {
    const latest = state.products.find((product) => product.id === (item.product_id || item.id));
    return latest ? {
      id: latest.id, product_id: latest.id, market_id: latest.market_id,
      market_name: latest.market_name, name: latest.name, price: Number(latest.price),
      qty: Math.min(item.qty || 1, latest.stock), stock: latest.stock,
    } : null;
  }).filter((item) => item && item.qty > 0);
  saveCart();
}

async function loadMarkets() {
  let marketQuery = await supabase.from('markets')
    .select('id,slug,name,description,image_url,is_active,is_pinned,sort_order,closes_at,created_at,products(id,market_id,name,description,price,image_url,stock,is_active,sort_order,created_at)');
  if (marketQuery.error && /is_pinned|sort_order/i.test(marketQuery.error.message || '')) {
    state.sortingReady = false;
    marketQuery = await supabase.from('markets')
      .select('id,slug,name,description,image_url,is_active,sort_order,closes_at,created_at,products(id,market_id,name,description,price,image_url,stock,is_active,created_at)');
  } else if (!marketQuery.error) state.sortingReady = true;
  if (marketQuery.error && /closes_at/i.test(marketQuery.error.message || '')) {
    state.operationsReady = false;
    marketQuery = await supabase.from('markets')
      .select('id,slug,name,description,image_url,is_active,sort_order,created_at,products(id,market_id,name,description,price,image_url,stock,is_active,created_at)')
      .order('created_at', { ascending: false });
  }

  if (!marketQuery.error) {
    state.marketFeatureReady = true;
    state.markets = normalizeMarkets(marketQuery.data);
  } else {
    const { data, error } = await supabase.from('products')
      .select('id,name,description,price,image_url,stock,is_active,created_at').order('created_at');
    if (error) throw error;
    state.marketFeatureReady = false;
    state.markets = normalizeMarkets([{
      id: 'legacy-retail', slug: 'retail', name: '零售區',
      description: '少量現貨與單品代購。', image_url: null,
      is_active: true, is_pinned: false, sort_order: 0, created_at: new Date(0).toISOString(), products: data || [],
    }]);
  }
  syncCartWithProducts();
}

async function loadProductCosts() {
  if (!state.user || !isManager()) return;
  let result = await supabase.from('product_costs').select('product_id,foreign_cost,exchange_rate,cost');
  if (result.error && /foreign_cost|exchange_rate/i.test(result.error.message || '')) {
    state.adminOpsReady = false;
    result = await supabase.from('product_costs').select('product_id,cost');
  }
  if (result.error) { state.costReady = false; return; }
  state.costReady = true;
  const costs = new Map((result.data || []).map((row) => [row.product_id, row]));
  state.markets.forEach((market) => market.products.forEach((product) => { const row = costs.get(product.id); product.foreign_cost = Number(row?.foreign_cost || 0); product.exchange_rate = Number(row?.exchange_rate || 0); product.cost = Number(row?.cost || 0); }));
  syncCartWithProducts();
}

async function loadProcurementChecks() {
  if (!state.user || !isManager()) return;
  const { data, error } = await supabase.from('procurement_checks').select('product_id,is_purchased,updated_at');
  if (error) { state.adminOpsReady = false; state.procurementChecks = new Map(); return; }
  state.procurementChecks = new Map((data || []).map((row) => [row.product_id, row]));
}

async function loadProfile() {
  if (!state.user) { state.profile = null; return; }
  const { data, error } = await supabase.from('profiles').select('id,username,display_name,role').eq('id', state.user.id).single();
  if (error) throw error;
  state.profile = data;
}

async function loadOrders() {
  if (!state.user) { state.orders = []; return; }
  let result = await supabase.from('orders')
    .select('id,order_number,user_id,account_email,customer_id,recipient_name,phone,delivery_method,note,status,total_amount,created_at,order_items(id,product_id,market_id,product_name,unit_cost,unit_price,original_unit_price,price_adjusted_at,quantity,subtotal)')
    .order('created_at', { ascending: false });
  if (result.error && /account_email/i.test(result.error.message || '')) {
    state.adminOpsReady = false;
    result = await supabase.from('orders')
      .select('id,order_number,user_id,customer_id,recipient_name,phone,delivery_method,note,status,total_amount,created_at,order_items(id,product_id,market_id,product_name,unit_cost,unit_price,original_unit_price,price_adjusted_at,quantity,subtotal)')
      .order('created_at', { ascending: false });
  }
  if (result.error && /unit_cost|original_unit_price|price_adjusted_at/i.test(result.error.message || '')) {
    if (/unit_cost/i.test(result.error.message || '')) state.costReady = false;
    if (/original_unit_price|price_adjusted_at/i.test(result.error.message || '')) state.pricingReady = false;
    result = await supabase.from('orders')
      .select('id,order_number,user_id,customer_id,recipient_name,phone,delivery_method,note,status,total_amount,created_at,order_items(id,product_id,market_id,product_name,unit_price,quantity,subtotal)')
      .order('created_at', { ascending: false });
  }
  if (result.error && /customer_id|product_id|market_id/i.test(result.error.message || '')) {
    state.operationsReady = false;
    result = await supabase.from('orders')
      .select('id,order_number,user_id,recipient_name,phone,delivery_method,note,status,total_amount,created_at,order_items(id,product_name,unit_price,quantity,subtotal)')
      .order('created_at', { ascending: false });
  }
  if (result.error) throw result.error;
  state.orders = result.data || [];
}

async function loadCustomers() {
  if (!state.user || !isManager()) { state.customers = []; return; }
  const { data, error } = await supabase.from('customers')
    .select('id,auth_user_id,email,recipient_name,phone,delivery_method,is_regular,is_vip,admin_note,created_at,updated_at')
    .order('updated_at', { ascending: false });
  if (error) {
    if (/customers/i.test(error.message || '')) { state.operationsReady = false; state.customers = []; return; }
    throw error;
  }
  state.customers = data || [];
}

async function syncSession(session) {
  state.user = session?.user || null;
  if (!state.user) {
    state.profile = null; state.orders = [];
    if (state.view === 'admin') state.view = 'shop';
    await loadMarkets(); render(); return;
  }
  try { await loadProfile(); await Promise.all([loadOrders(), loadMarkets(), loadCustomers(), loadProcurementChecks()]); await loadProductCosts(); }
  catch (error) { renderToast(friendlyError(error)); }
  render();
}

async function initialize() {
  try {
    const [{ data }] = await Promise.all([supabase.auth.getSession(), loadMarkets()]);
    await syncSession(data.session);
  } catch (error) { renderToast(`Supabase 連線失敗：${friendlyError(error)}`); }
  finally { state.loading = false; render(); }
}

supabase.auth.onAuthStateChange((event, session) => window.setTimeout(() => {
  if (event === 'PASSWORD_RECOVERY') {
    state.user = session?.user || null; state.modal = 'new-password'; render(); return;
  }
  if (state.user?.id && state.user.id === session?.user?.id && (event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN')) {
    state.user = session.user; return;
  }
  syncSession(session);
}, 0));

function nav() {
  const admin = isManager() ? `<button class="${state.view === 'admin' ? 'active' : ''}" data-view="admin">管理員後台</button>` : '';
  const member = state.user ? esc(state.user.email || '會員') : '登入';
  return `<header class="nav"><button class="brand" data-view="shop"><span class="brand-mark"><span class="brand-logo-fallback">NS</span><img class="brand-logo" src="/assets/newshop-logo.png?v=2" alt="NewShop Logo"/></span><span>NewShop連線代購</span></button><nav class="navlinks"><button class="${state.view === 'shop' ? 'active' : ''}" data-view="shop">逛賣場</button><button data-scroll="guide">購物須知</button><button class="${state.view === 'orders' ? 'active' : ''}" data-view="orders">${member}</button>${admin}<button class="cart-btn" data-action="cart">購物車 <span class="badge">${cartCount()}</span></button></nav></header>`;
}

function marketPrice(market) {
  const items = market.products.filter((item) => item.is_active);
  const prices = items.map((item) => Number(item.price));
  if (!prices.length) return '暫無品項';
  const min = Math.min(...prices); const max = Math.max(...prices);
  return min === max ? money(min) : `${money(min)} 起`;
}

function marketCard(market, index) {
  const items = market.products.filter((item) => item.is_active);
  const cover = market.image_url || items.find((item) => item.image_url)?.image_url;
  const art = cover ? `<img src="${esc(cover)}" alt="${esc(market.name)}" />` : `<span class="market-emoji">${market.emoji}</span>`;
  const closed = isClosed(market); const soldOut = !items.some((item) => Number(item.stock) > 0);
  const unavailable = soldOut || closed;
  return `<article class="market-card reveal" style="--delay:${Math.min(index * 70, 280)}ms"><button class="market-cover" data-open-market="${market.id}" aria-label="查看 ${esc(market.name)}">${art}<span class="market-arrow">↗</span></button><div class="market-copy"><div class="market-meta"><span>${items.length} 個品項</span><span>${closed ? '已截止' : soldOut ? '已售完' : '開放中'}</span></div><h3>${esc(market.name)}</h3><p>${esc(market.description || '精選限定商品。')}</p>${market.closes_at ? `<div class="deadline">收單至 ${new Date(market.closes_at).toLocaleDateString('zh-TW')}</div>` : ''}<div class="market-bottom"><strong>${marketPrice(market)}</strong><button class="text-link" data-open-market="${market.id}">${unavailable ? (closed ? '已截止・查看商品' : '無庫存・查看商品') : '進入賣場 →'}</button></div></div></article>`;
}

function shop() {
  const markets = state.markets.filter((market) => market.is_active);
  const cards = state.loading ? `<div class="empty">正在同步連線賣場…</div>` : markets.length ? markets.map(marketCard).join('') : `<div class="empty">目前沒有上架賣場</div>`;
  return `<main><section id="markets" class="catalog-first"><div class="markets-grid">${cards}</div></section><section id="guide" class="guide compact-guide"><div class="guide-title"><span>HOW TO ORDER</span><h2>簡單三步驟</h2></div><div class="guide-grid"><article><span>01</span><h3>進入賣場</h3><p>查看各賣場的品項與收單期限。</p></article><article><span>02</span><h3>加入購物車</h3><p>選擇品項和數量，售完會直接顯示無庫存。</p></article><article><span>03</span><h3>登入送單</h3><p>送出後可隨時查詢訂單進度。</p></article></div></section></main>`;
}

function orderRow(order) {
  const items = order.order_items || [];
  return `<div class="order"><div><strong>${esc(order.order_number)}</strong><small class="account-email">下單帳號：${esc(order.account_email || state.user?.email || '未記錄')}</small><div class="order-items">${items.map((item) => `${esc(item.product_name)} × ${item.quantity}`).join('、')}</div><small>${new Date(order.created_at).toLocaleString('zh-TW')}</small></div><div class="order-price"><strong>${money(order.total_amount)}</strong><div class="status">${statusLabels[order.status] || esc(order.status)}</div></div></div>`;
}

function ordersView() {
  if (!state.user) return `<main class="split"><section class="panel"><span class="eyebrow">MEMBER AREA</span><h2>登入後查看訂單</h2><p>使用信箱建立帳號，就能跨裝置查詢訂購進度。</p><button class="btn btn-primary" data-modal="auth">登入／註冊</button></section><section class="panel"><h2>訂單紀錄</h2><div class="empty">登入後顯示你的訂單</div></section></main>`;
  const ownOrders = state.orders.filter((order) => order.user_id === state.user.id);
  return `<main class="split"><section class="panel member-card"><span class="eyebrow">MEMBER AREA</span><h2>我的訂單</h2><p>${esc(state.user.email)}</p><button class="btn btn-primary" data-action="logout">登出</button></section><section class="panel"><h2>訂單紀錄</h2>${ownOrders.length ? ownOrders.map(orderRow).join('') : `<div class="empty">目前還沒有訂單<br/><button class="btn btn-accent" data-view="shop">去逛逛</button></div>`}</section></main>`;
}

function marketSummaries(includeZero = false) {
  return state.markets.map((market) => ({
    market,
    rows: market.products.map((product) => {
      const itemOrders = state.orders.filter((order) => order.status !== 'cancelled').flatMap((order) =>
        (order.order_items || []).filter((item) => item.product_id === product.id || (item.market_id === market.id && item.product_name === product.name)).map((item) => ({ ...item, order })),
      );
      const quantity = itemOrders.reduce((sum, item) => sum + Number(item.quantity), 0); const currentCost = Number(product.cost || 0);
      const revenue = itemOrders.reduce((sum, item) => sum + Number(item.unit_price) * Number(item.quantity), 0);
      const totalCost = itemOrders.reduce((sum, item) => sum + Number(item.unit_cost ?? currentCost) * Number(item.quantity), 0);
      const cost = quantity ? totalCost / quantity : currentCost; const price = quantity ? revenue / quantity : Number(product.price || 0);
      return { product, quantity, cost, price, revenue, totalCost, profit: revenue - totalCost, buyers: new Set(itemOrders.map((item) => item.order.customer_id || item.order.phone)).size, procured: Boolean(state.procurementChecks.get(product.id)?.is_purchased) };
    }).filter((row) => includeZero || row.quantity > 0),
  })).filter((entry) => includeZero || entry.rows.length);
}

function procurementSubtotalRow(rows) {
  const quantity = rows.reduce((sum, row) => sum + Number(row.quantity), 0);
  const foreignTotal = rows.reduce((sum, row) => sum + Number(row.product.foreign_cost || 0) * Number(row.quantity), 0);
  const rates = rows.map((row) => Number(row.product.exchange_rate || 0)).filter((rate) => rate > 0);
  const averageRate = rates.length ? rates.reduce((sum, rate) => sum + rate, 0) / rates.length : 0;
  const buyers = rows.reduce((sum, row) => sum + Number(row.buyers), 0);
  const profit = rows.reduce((sum, row) => sum + Number(row.profit), 0);
  return `<tfoot><tr class="procurement-subtotal"><td></td><td><strong>小計</strong></td><td><strong>${quantity}</strong></td><td>${foreignTotal.toLocaleString('zh-TW', { maximumFractionDigits: 2 })}</td><td>${averageRate.toLocaleString('zh-TW', { maximumFractionDigits: 4 })}</td><td>—</td><td>—</td><td><strong>${buyers}</strong></td><td class="profit ${profit < 0 ? 'negative' : ''}"><strong>${money(profit)}</strong></td></tr></tfoot>`;
}

function latestCustomerOrder(customer) {
  return state.orders.find((order) => order.customer_id === customer.id || (!order.customer_id && customer.phone && order.phone === customer.phone));
}

function shipmentSummaries() {
  const recipients = new Map();
  for (const order of state.orders.filter((entry) => entry.status !== 'cancelled')) {
    const key = `${String(order.recipient_name).trim().toLowerCase()}|${String(order.phone).trim()}`;
    if (!recipients.has(key)) recipients.set(key, { recipient: order.recipient_name, phone: order.phone, delivery: order.delivery_method, accounts: new Set(), items: new Map(), amount: 0, profit: 0 });
    const recipient = recipients.get(key);
    if (order.account_email) recipient.accounts.add(order.account_email);
    for (const item of order.order_items || []) {
      const itemKey = item.product_id || item.product_name; const product = state.products.find((entry) => entry.id === item.product_id);
      const unitCost = Number(item.unit_cost ?? product?.cost ?? 0); const quantity = Number(item.quantity); const amount = Number(item.unit_price) * quantity; const profit = amount - unitCost * quantity;
      const market = state.markets.find((entry) => entry.id === item.market_id);
      const imageUrl = product?.image_url || market?.image_url || '';
      if (!recipient.items.has(itemKey)) recipient.items.set(itemKey, { name: item.product_name, image_url: imageUrl, quantity: 0, amount: 0, profit: 0 });
      const row = recipient.items.get(itemKey); row.quantity += quantity; row.amount += amount; row.profit += profit;
      recipient.amount += amount; recipient.profit += profit;
    }
  }
  return [...recipients.values()].map((recipient) => ({ ...recipient, account: [...recipient.accounts].join('、') || '未記錄', items: [...recipient.items.values()] }));
}

function orderItemEditor(item) {
  const adjusted = item.original_unit_price != null;
  const product = state.products.find((entry) => entry.id === item.product_id); const market = state.markets.find((entry) => entry.id === item.market_id || entry.id === product?.market_id); const image = product?.image_url || market?.image_url;
  return `<div class="order-item-admin ${adjusted ? 'price-adjusted' : ''}"><div class="order-item-identity"><span class="order-item-thumb">${image ? `<img src="${esc(image)}" alt="" loading="lazy"/>` : 'IMG'}</span><span><strong>${esc(item.product_name)}</strong><small>${esc(market?.name || '未分類賣場')}</small></span></div><div class="item-admin-controls"><label>數量<input data-order-item-quantity="${item.id}" type="number" min="0" step="1" value="${item.quantity}" title="輸入 0 會刪除此品項" ${state.adminOpsReady ? '' : 'disabled'}/></label><button data-save-item-quantity="${item.id}" ${state.adminOpsReady ? '' : 'disabled'}>改數量</button><label>單價<input data-order-item-price="${item.id}" type="number" min="0" value="${Number(item.unit_price)}" ${state.pricingReady ? '' : 'disabled'}/></label><button data-save-item-price="${item.id}" ${state.pricingReady ? '' : 'disabled'}>改金額</button></div>${adjusted ? `<small>人工改價・原價 ${money(item.original_unit_price)}</small>` : ''}</div>`;
}

function adminView() {
  if (!isManager()) return `<main class="panel admin-page"><div class="empty">這個頁面只開放管理員</div></main>`;
  const total = state.orders.filter((order) => order.status !== 'cancelled').reduce((sum, order) => sum + Number(order.total_amount), 0);
  const statusOptions = (current) => Object.entries(statusLabels).map(([value, label]) => `<option value="${value}" ${current === value ? 'selected' : ''}>${label}</option>`).join('');
  const viewingOrders = state.orders.filter((order) => state.adminOrderHistory ? ['completed', 'cancelled'].includes(order.status) : !['completed', 'cancelled'].includes(order.status));
  const orderRows = viewingOrders.map((order) => `<tr><td>${esc(order.order_number)}<small class="account-email">${esc(order.account_email || '帳號未記錄')}</small></td><td>${esc(order.recipient_name)}<br/><small>${order.phone ? `${esc(order.phone)}・` : ''}${esc(order.delivery_method)}</small></td><td>${(order.order_items || []).map(orderItemEditor).join('')}</td><td>${money(order.total_amount)}</td><td><select data-order-status="${order.id}">${statusOptions(order.status)}</select></td><td><button class="btn btn-danger-soft" data-delete-order="${order.id}" ${state.adminOpsReady ? '' : 'disabled'}>刪除</button></td></tr>`).join('');
  const marketRows = state.markets.map((market) => { const cover = market.image_url || market.products.find((item) => item.image_url)?.image_url; return `<tr class="sortable-market ${market.is_pinned ? 'is-pinned' : ''}" data-market-sort="${market.id}" data-sort-group="${market.is_pinned ? 'pinned' : 'normal'}"><td><button class="drag-handle" data-market-drag aria-label="拖曳調整 ${esc(market.name)} 排序" title="拖曳排序" ${state.sortingReady ? '' : 'disabled'}>⋮⋮</button></td><td><div class="admin-market"><span class="admin-thumb">${cover ? `<img src="${esc(cover)}" alt=""/>` : market.emoji}</span><span><strong>${esc(market.name)}</strong><small>${market.is_pinned ? '已置頂・' : ''}${market.is_active ? '已上架' : '已下架'}・${market.closes_at ? `收單 ${new Date(market.closes_at).toLocaleDateString('zh-TW')}` : '未設定期限'}</small></span></div></td><td>${market.products.length}</td><td>${market.products.reduce((sum, item) => sum + Number(item.stock), 0)}</td><td><div class="admin-actions"><button class="btn ${market.is_pinned ? 'btn-accent' : 'btn-light'}" data-pin-market="${market.id}" ${state.sortingReady ? '' : 'disabled'}>${market.is_pinned ? '取消置頂' : '置頂'}</button><button class="btn btn-light" data-edit-market="${market.id}">編輯</button><button class="btn ${market.is_active ? 'btn-danger-soft' : 'btn-accent'}" data-toggle-market="${market.id}">${market.is_active ? '下架' : '上架'}</button><button class="btn btn-danger-soft" data-delete-market="${market.id}">刪除</button></div></td></tr>`; }).join('');
  const customerRows = state.customers.map((customer) => { const latest = latestCustomerOrder(customer); const latestItem = latest ? (latest.order_items || []).map((item) => item.product_name).join('、') : '尚未下單'; return `<tr data-customer-row="${customer.id}"><td><input data-customer-name value="${esc(customer.recipient_name)}"/></td><td><input data-customer-email type="email" value="${esc(customer.email || '')}" placeholder="選填"/></td><td><input data-customer-phone value="${esc(customer.phone || '')}" placeholder="選填"/></td><td><select data-customer-delivery>${deliverySelect(customer.delivery_method)}</select></td><td>${esc(latestItem)}${latest ? `<small>${new Date(latest.created_at).toLocaleDateString('zh-TW')}</small>` : ''}</td><td class="customer-flag"><input data-customer-regular type="checkbox" aria-label="常客" ${customer.is_regular ? 'checked' : ''}/></td><td class="customer-flag vip"><input data-customer-vip type="checkbox" aria-label="VIP" ${customer.is_vip ? 'checked' : ''}/></td><td><input data-customer-note value="${esc(customer.admin_note)}" placeholder="內部備註"/></td><td><div class="admin-actions"><button class="btn btn-light" data-save-customer="${customer.id}">儲存</button><button class="btn btn-danger-soft" data-delete-customer="${customer.id}">刪除</button></div></td></tr>`; }).join('');
  const summaries = marketSummaries().map((entry) => ({ ...entry, rows: entry.rows.filter((row) => row.procured === state.procurementHistory) })).filter((entry) => entry.rows.length);
  const visibleSummaryRows = summaries.flatMap((entry) => entry.rows);
  const summaryQuantity = visibleSummaryRows.reduce((sum, row) => sum + row.quantity, 0);
  const summaryProfit = visibleSummaryRows.reduce((sum, row) => sum + row.profit, 0);
  const shipments = shipmentSummaries();
  const shipmentRows = shipments.map((recipient) => `<tr><td><strong>${esc(recipient.recipient)}</strong><small>${esc(recipient.account)}</small><small>${recipient.phone ? `${esc(recipient.phone)}・` : ''}${esc(recipient.delivery)}</small></td><td><div class="shipment-items">${recipient.items.map((item) => `<div class="shipment-item"><span class="shipment-thumb">${item.image_url ? `<img src="${esc(item.image_url)}" alt="" loading="lazy"/>` : '<span>IMG</span>'}</span><span><strong>${esc(item.name)}</strong><small>× ${item.quantity}</small></span></div>`).join('')}</div></td><td>${recipient.items.reduce((sum, item) => sum + item.quantity, 0)}</td><td>${money(recipient.amount)}</td><td class="profit ${recipient.profit < 0 ? 'negative' : ''}">${money(recipient.profit)}</td></tr>`).join('');
  const summaryHtml = summaries.length ? summaries.map(({ market, rows }) => `<article class="summary-card"><div class="summary-head"><h3>${esc(market.name)}</h3><span>獲利 ${money(rows.reduce((sum, row) => sum + row.profit, 0))}</span></div><div class="table-wrap"><table class="admin-table procurement-table"><thead><tr><th>完成</th><th>商品</th><th>數量</th><th>外幣成本</th><th>匯率</th><th>單件成本</th><th>售價</th><th>購買人數</th><th>獲利</th></tr></thead><tbody>${rows.map((row) => `<tr><td><input class="procurement-check" data-procurement-product="${row.product.id}" type="checkbox" ${row.procured ? 'checked' : ''} ${state.adminOpsReady ? '' : 'disabled'}/></td><td><div class="procurement-product"><span class="procurement-thumb">${row.product.image_url ? `<img src="${esc(row.product.image_url)}" alt="" loading="lazy"/>` : market.image_url ? `<img src="${esc(market.image_url)}" alt="" loading="lazy"/>` : 'IMG'}</span><span><strong>${esc(row.product.name)}</strong><small>${esc(market.name)}</small></span></div></td><td><strong>${row.quantity}</strong></td><td>${Number(row.product.foreign_cost || 0).toLocaleString()}</td><td>${Number(row.product.exchange_rate || 0).toLocaleString()}</td><td>${money(row.cost)}</td><td>${money(row.price)}</td><td>${row.buyers}</td><td class="profit ${row.profit < 0 ? 'negative' : ''}">${money(row.profit)}</td></tr>`).join('')}</tbody>${procurementSubtotalRow(rows)}</table></div></article>`).join('') : `<div class="empty">${state.procurementHistory ? '目前沒有採購歷史' : '目前沒有待採購商品'}</div>`;
  const migrationNotice = `${state.operationsReady ? '' : `<div class="setup-notice">請先執行 <strong>customer_operations_upgrade.sql</strong>。</div>`}${state.costReady ? '' : `<div class="setup-notice">請執行 <strong>product_cost_upgrade.sql</strong>。</div>`}${state.pricingReady ? '' : `<div class="setup-notice">請執行 <strong>order_price_adjustment_upgrade.sql</strong>。</div>`}${state.adminOpsReady ? '' : `<div class="setup-notice">請執行最新的 <strong>admin_operations_upgrade.sql</strong>，才能使用帳號、外幣成本、數量修改、刪除與採購歷史。</div>`}${state.sortingReady ? '' : `<div class="setup-notice">請執行 <strong>sorting_upgrade.sql</strong>，才能使用賣場置頂與拖曳排序。</div>`}`;
  const orderPanel = `<section class="panel"><div class="section-head"><div><span class="eyebrow">ORDERS</span><h2>訂單總覽</h2><p>${esc(state.user?.email)} ・ 完成或取消的訂單會自動移入歷史</p></div><button class="btn btn-primary" data-action="export">下載 Excel 報表</button></div><div class="sub-tabs"><button class="${!state.adminOrderHistory ? 'active' : ''}" data-order-history="current">目前訂單</button><button class="${state.adminOrderHistory ? 'active' : ''}" data-order-history="history">歷史清單</button></div><div class="admin-stats"><div class="stat"><small>總訂單</small><strong>${state.orders.length}</strong></div><div class="stat"><small>待處理</small><strong>${state.orders.filter((order) => order.status === 'pending').length}</strong></div><div class="stat"><small>有效訂單總額</small><strong>${money(total)}</strong></div></div>${viewingOrders.length ? `<div class="table-wrap"><table class="admin-table"><thead><tr><th>訂單／下單帳號</th><th>收件資訊</th><th>品項</th><th>金額</th><th>狀態</th><th>操作</th></tr></thead><tbody>${orderRows}</tbody></table></div>` : `<div class="empty">${state.adminOrderHistory ? '目前沒有歷史訂單' : '目前沒有處理中的訂單'}</div>`}</section>`;
  const summaryPanel = `<section class="panel"><div class="section-head"><div><span class="eyebrow">PURCHASE SUMMARY</span><h2>各賣場採購統計</h2><p>勾選完成後會移入採購歷史，可隨時取消勾選移回。</p></div><button class="btn btn-primary" data-action="export">下載 Excel 報表</button></div><div class="sub-tabs"><button class="${!state.procurementHistory ? 'active' : ''}" data-procurement-history="current">待採購</button><button class="${state.procurementHistory ? 'active' : ''}" data-procurement-history="history">採購歷史</button></div><div class="admin-stats procurement-stats"><div class="stat"><small>本頁商品總數</small><strong>${summaryQuantity}</strong></div><div class="stat"><small>${state.procurementHistory ? '本頁已完成品項' : '本頁尚未完成品項'}</small><strong>${visibleSummaryRows.length}</strong></div><div class="stat"><small>本頁訂單獲利</small><strong>${money(summaryProfit)}</strong></div></div><div class="summary-grid">${summaryHtml}</div></section>`;
  const shipmentPanel = `<section class="panel"><div class="section-head"><div><span class="eyebrow">SHIPMENT LIST</span><h2>發貨清單</h2><p>依收件人彙整帳號、商品與有效訂單。</p></div><button class="btn btn-primary" data-action="export">下載 Excel 報表</button></div>${shipments.length ? `<div class="table-wrap"><table class="admin-table shipment-table"><thead><tr><th>收件人／下單帳號</th><th>訂購商品</th><th>總數量</th><th>金額</th><th>獲利</th></tr></thead><tbody>${shipmentRows}</tbody></table></div>` : `<div class="empty">目前沒有待整理的發貨資料</div>`}</section>`;
  const customerPanel = `<section class="panel"><div class="section-head"><div><span class="eyebrow">CUSTOMERS</span><h2>購買人與常客清單</h2><p>只有收件人為必填，信箱與電話皆可留空。</p></div><button class="btn btn-accent" data-action="new-customer" ${state.operationsReady ? '' : 'disabled'}>＋ 新增常客</button></div>${state.customers.length ? `<div class="table-wrap"><table class="admin-table customer-table"><thead><tr><th>收件人</th><th>信箱（選填）</th><th>電話（選填）</th><th>取貨方式</th><th>最近商品</th><th class="customer-flag">常客</th><th class="customer-flag vip">VIP</th><th>備註</th><th>操作</th></tr></thead><tbody>${customerRows}</tbody></table></div>` : `<div class="empty">尚無買家資料；會員完成第一筆訂單後會自動建立。</div>`}</section>`;
  const marketPanel = `<section class="panel"><div class="section-head"><div><span class="eyebrow">MARKETS & ITEMS</span><h2>賣場管理</h2><p>拖曳調整同一區內的順序；可同時置頂多個賣場。</p></div><button class="btn btn-accent" data-action="new-market" ${state.marketFeatureReady ? '' : 'disabled'}>＋ 建立賣場</button></div>${state.markets.length ? `<div class="table-wrap"><table class="admin-table market-sort-table"><thead><tr><th>排序</th><th>賣場</th><th>品項數</th><th>總庫存</th><th>操作</th></tr></thead><tbody id="market-sort-list">${marketRows}</tbody></table></div>` : `<div class="empty">尚未建立賣場</div>`}</section>`;
  const panels = { orders: orderPanel, summary: summaryPanel, shipments: shipmentPanel, customers: customerPanel, markets: marketPanel };
  return `<main class="admin-page">${migrationNotice}<div class="admin-tabs" role="tablist"><button class="${state.adminTab === 'markets' ? 'active' : ''}" data-admin-tab="markets">賣場管理</button><button class="${state.adminTab === 'orders' ? 'active' : ''}" data-admin-tab="orders">訂單管理</button><button class="${state.adminTab === 'summary' ? 'active' : ''}" data-admin-tab="summary">採購統計</button><button class="${state.adminTab === 'shipments' ? 'active' : ''}" data-admin-tab="shipments">發貨清單</button><button class="${state.adminTab === 'customers' ? 'active' : ''}" data-admin-tab="customers">客戶管理</button></div>${panels[state.adminTab] || marketPanel}</main>`;
}

function footer() { return `<footer><strong>NewShop連線代購</strong><span><a href="mailto:sky604510@gmail.com">sky604510@gmail.com</a> ・ 會員與訂單由 Supabase 安全保存</span></footer>`; }

function marketDetailModal() {
  const market = state.markets.find((item) => item.id === state.selectedMarketId);
  if (!market) return '';
  const items = market.products.filter((item) => item.is_active).sort((a, b) => Number(Number(a.stock) <= 0) - Number(Number(b.stock) <= 0));
  const selected = items.find((item) => item.id === state.selectedProductId) || items.find((item) => item.stock > 0) || items[0];
  const cover = selected?.image_url || market.image_url;
  const art = cover ? `<img class="detail-product-image" src="${esc(cover)}" alt="${esc(market.name)}" />` : `<span class="detail-emoji">${market.emoji}</span>`;
  const closed = isClosed(market);
  return `<div class="modal-backdrop"><div class="modal market-detail"><button class="close detail-close" data-action="close">×</button><div class="detail-media">${art}<span class="market-pill">${esc(market.name)}</span></div><div class="detail-copy"><span class="eyebrow">SELECT YOUR ITEM</span><h2>${esc(market.name)}</h2><p>${esc(market.description)}</p>${market.closes_at ? `<div class="deadline ${closed ? 'closed' : ''}">${closed ? '此賣場已截止收單' : `收單至 ${new Date(market.closes_at).toLocaleDateString('zh-TW')}`}</div>` : ''}<div class="item-label">品項 <small>每款價格獨立計算</small></div><div class="item-options">${items.map((item) => `<button class="item-option ${selected?.id === item.id ? 'selected' : ''}" data-select-item="${item.id}" aria-pressed="${selected?.id === item.id}" ${item.stock <= 0 || closed ? 'disabled' : ''}><span>${esc(item.name)}</span><strong>${money(item.price)}</strong><small>${item.stock > 0 && !closed ? '可購買' : '無庫存'}</small></button>`).join('')}</div>${selected ? `<div class="detail-buy"><div><span>數量</span><div class="qty-control"><button data-detail-qty="-1" ${state.detailQty <= 1 ? 'disabled' : ''}>−</button><strong data-detail-count>${state.detailQty}</strong><button data-detail-qty="1" ${state.detailQty >= selected.stock || closed ? 'disabled' : ''}>＋</button></div></div><div class="detail-total"><span>小計</span><strong data-detail-total>${money(Number(selected.price) * state.detailQty)}</strong></div></div><button class="btn btn-primary add-cart-wide" data-action="add-selected-item" ${selected.stock <= 0 || closed ? 'disabled' : ''}>${closed ? '賣場已截止收單' : selected.stock <= 0 ? '無庫存' : '加入購物車'}</button>` : `<div class="empty">這個賣場還沒有品項</div>`}</div></div></div>`;
}

function cartModal() {
  return `<div class="modal-backdrop"><div class="modal cart-modal"><div class="modal-head"><div><span class="eyebrow">YOUR CART</span><h2>購物車</h2></div><button class="close" data-action="close">×</button></div>${state.cart.length ? `${state.cart.map((item) => `<div class="cart-line" data-cart-line="${item.id}"><div><small>${esc(item.market_name || '零售區')}</small><strong>${esc(item.name)}</strong><div class="cart-subtotal" data-cart-subtotal="${item.id}">${money(Number(item.price) * item.qty)}</div></div><div class="cart-controls"><button data-cart-change="${item.id}" data-delta="-1">−</button><strong data-cart-qty="${item.id}">${item.qty}</strong><button data-cart-change="${item.id}" data-delta="1" ${item.qty >= item.stock ? 'disabled' : ''}>＋</button><button class="remove-link" data-remove="${item.id}">移除</button></div></div>`).join('')}<div class="cart-total"><strong>商品合計</strong><strong data-cart-total>${money(cartTotal())}</strong></div><p class="cart-note">最終付款與取貨資訊由店主確認。</p><div class="cart-actions"><button class="btn btn-light" data-action="continue-shopping">繼續購物</button><button class="btn btn-primary" data-action="begin-checkout">前往結帳</button></div>` : `<div class="empty">購物車還是空的</div>`}</div></div>`;
}

function authModal() {
  const register = state.authMode === 'register';
  return `<div class="modal-backdrop"><div class="modal"><div class="modal-head"><div><span class="eyebrow">MEMBER</span><h2>${register ? '使用 Email 註冊' : '會員登入'}</h2></div><button class="close" data-action="close">×</button></div><div class="auth-tabs"><button class="${!register ? 'active' : ''}" data-auth-mode="login">登入</button><button class="${register ? 'active' : ''}" data-auth-mode="register">註冊</button></div><div class="field"><label>Email</label><input id="email" type="email" autocomplete="email" placeholder="you@example.com" /></div><div class="field"><label>密碼</label><input id="password" type="password" autocomplete="${register ? 'new-password' : 'current-password'}" placeholder="至少 6 個字元" /></div><button class="btn btn-primary add-cart-wide" data-action="${register ? 'signup' : 'login'}" ${state.busy ? 'disabled' : ''}>${state.busy ? '處理中…' : register ? '建立帳號' : '登入'}</button>${register ? '' : `<button class="forgot-link" data-action="forgot-password">忘記密碼？</button>`}</div></div>`;
}

function forgotPasswordModal() { return `<div class="modal-backdrop"><div class="modal"><div class="modal-head"><div><span class="eyebrow">PASSWORD RESET</span><h2>重設密碼</h2></div><button class="close" data-action="close">×</button></div><p>輸入註冊 Email，我們會寄送密碼重設連結。</p><div class="field"><label>Email</label><input id="recover-email" type="email" autocomplete="email" /></div><button class="btn btn-primary add-cart-wide" data-action="send-recovery">寄送重設信</button><button class="forgot-link" data-action="back-login">返回登入</button></div></div>`; }
function newPasswordModal() { return `<div class="modal-backdrop"><div class="modal"><div class="modal-head"><div><span class="eyebrow">NEW PASSWORD</span><h2>設定新密碼</h2></div></div><div class="field"><label>新密碼</label><input id="new-password" type="password" autocomplete="new-password" /></div><div class="field"><label>再次輸入</label><input id="confirm-password" type="password" autocomplete="new-password" /></div><button class="btn btn-primary add-cart-wide" data-action="update-password">更新密碼</button></div></div>`; }
function checkoutModal() {
  const draft = state.checkoutDraft || {}; const regulars = state.customers.filter((customer) => customer.is_regular);
  const adminModes = isManager() ? `<div class="auth-tabs"><button class="${state.checkoutMode === 'general' ? 'active' : ''}" data-checkout-mode="general">一般模式</button><button class="${state.checkoutMode === 'regular' ? 'active' : ''}" data-checkout-mode="regular">常客代下單</button></div>${state.checkoutMode === 'regular' ? `<div class="field"><label>選擇常客</label><select id="regular-customer"><option value="">請選擇</option>${regulars.map((customer) => `<option value="${customer.id}" ${draft.customerId === customer.id ? 'selected' : ''}>${esc(customer.recipient_name)}${customer.phone ? `・${esc(customer.phone)}` : ''}${customer.is_vip ? '・VIP' : ''}</option>`).join('')}</select></div>` : ''}` : '';
  return `<div class="modal-backdrop"><div class="modal"><div class="modal-head"><div><span class="eyebrow">CHECKOUT</span><h2>確認訂單</h2></div><button class="close" data-action="close">×</button></div>${adminModes}<div class="field"><label>收件人（必填）</label><input id="customer" autocomplete="name" value="${esc(draft.recipient || '')}" /></div><div class="field"><label>聯絡電話（選填）</label><input id="phone" autocomplete="tel" value="${esc(draft.phone || '')}" /></div><div class="field"><label>取貨方式</label><select id="delivery">${deliverySelect(draft.delivery || '面交取貨')}</select></div><div class="field"><label>訂單備註</label><input id="note" value="${esc(draft.note || '')}" placeholder="顏色、尺寸或其他需求（選填）" /></div><p class="draft-hint">輸入內容會自動保存在這台裝置，切換分頁也不會消失。</p><button class="btn btn-primary add-cart-wide" data-action="checkout" ${state.busy ? 'disabled' : ''}>${state.busy ? '送出中…' : `${state.checkoutMode === 'regular' ? '代客送出訂單' : '送出訂單'} ・ ${money(cartTotal())}`}</button></div></div>`;
}

function customerEditorModal() {
  const draft = state.customerDraft || { recipient_name: '', phone: '', delivery_method: '面交取貨', email: '', is_regular: true, is_vip: false, admin_note: '' };
  return `<div class="modal-backdrop"><div class="modal"><div class="modal-head"><div><span class="eyebrow">REGULAR CUSTOMER</span><h2>新增常客</h2></div><button class="close" data-action="close">×</button></div><div class="field"><label>收件人（必填）</label><input id="new-customer-name" value="${esc(draft.recipient_name)}"/></div><div class="field"><label>聯絡電話（選填）</label><input id="new-customer-phone" value="${esc(draft.phone)}"/></div><div class="field"><label>Email（選填）</label><input id="new-customer-email" type="email" value="${esc(draft.email)}"/></div><div class="field"><label>取貨方式</label><select id="new-customer-delivery">${deliverySelect(draft.delivery_method)}</select></div><div class="field"><label>管理員備註</label><input id="new-customer-note" value="${esc(draft.admin_note)}" placeholder="例：偏好、需留意事項"/></div><div class="tag-options"><label class="check-field"><input id="new-customer-regular" type="checkbox" ${draft.is_regular !== false ? 'checked' : ''}/><span>加入常客清單</span></label><label class="check-field"><input id="new-customer-vip" type="checkbox" ${draft.is_vip ? 'checked' : ''}/><span>VIP 客戶</span></label></div><button class="btn btn-primary add-cart-wide" data-action="create-customer">建立常客</button></div></div>`;
}
function successModal() { const order = state.lastOrder; return `<div class="modal-backdrop"><div class="modal success-modal"><div class="success-mark">✓</div><span class="eyebrow">ORDER RECEIVED</span><h2>訂單已成功送出</h2><p>我們會盡快確認採購內容。</p><div class="success-order"><span>訂單編號</span><strong>${esc(order?.order_number || '處理中')}</strong><span>下單帳號</span><strong>${esc(order?.account_email || state.user?.email || '未記錄')}</strong><span>商品金額</span><strong>${money(order?.total_amount || 0)}</strong></div><button class="btn btn-primary add-cart-wide" data-action="view-orders">查看我的訂單</button><button class="forgot-link" data-action="continue-shopping">繼續逛逛</button></div></div>`; }

function createMarketDraft(market) {
  const defaultClose = new Date(); defaultClose.setMonth(defaultClose.getMonth() + 1);
  return {
    name: market?.name || '', description: market?.description || '', image_url: market?.image_url || '', file: null, removeBg: false,
    closes_at: dateValue(market?.closes_at) || dateValue(defaultClose),
    is_active: market?.is_active ?? true, sort_order: market?.sort_order || 0,
    products: (market?.products || []).map((item, index) => ({ ...item, key: item.id, sort_order: item.sort_order ?? index, file: null, removeBg: false })),
  };
}

function marketEditorModal() {
  const draft = state.marketDraft || createMarketDraft();
  const rows = draft.products.map((item, index) => `<div class="item-editor compact-item" data-item-row data-key="${esc(item.key)}" data-id="${esc(item.id || '')}"><button class="item-index drag-handle" data-item-drag aria-label="拖曳調整 ${esc(item.name || `品項 ${index + 1}`)} 排序" title="拖曳排序" ${state.sortingReady ? '' : 'disabled'}>${index + 1}</button><label class="compact-input item-name"><span>商品名稱</span><input data-item-name value="${esc(item.name || '')}" placeholder="商品或規格名稱"/></label><label class="compact-input"><span>外幣成本</span><input data-item-foreign-cost type="number" min="0" step="0.01" value="${item.foreign_cost ?? 0}"/></label><label class="compact-input"><span>匯率</span><input data-item-exchange-rate type="number" min="0" step="0.0001" value="${item.exchange_rate ?? 0}"/></label><label class="compact-input"><span>成本</span><input data-item-cost type="number" min="0" step="0.01" value="${item.cost ?? 0}"/></label><label class="compact-input"><span>售價</span><input data-item-price type="number" min="0" value="${item.price ?? ''}"/></label><label class="compact-input"><span>數量</span><input data-item-stock type="number" min="0" step="1" value="${item.stock ?? 0}"/></label><div class="compact-image"><span class="upload-thumb">${item.file ? `<img src="${URL.createObjectURL(item.file)}" alt="預覽"/>` : item.image_url ? `<img src="${esc(item.image_url)}" alt="預覽"/>` : 'IMG'}</span><label class="image-pick" title="選擇商品圖片">＋<input data-item-image type="file" accept="image/jpeg,image/png,image/webp,image/gif"/></label><label class="remove-bg-mini" title="自動去除淺色背景"><input data-item-remove-bg type="checkbox" ${item.removeBg ? 'checked' : ''}/>去背</label></div><label class="mini-switch"><input data-item-active type="checkbox" ${item.is_active !== false ? 'checked' : ''}/><span>上架</span></label><button class="item-delete" data-remove-draft-item="${esc(item.key)}" data-product-id="${esc(item.id || '')}" title="刪除商品" aria-label="刪除 ${esc(item.name || `品項 ${index + 1}`)}">×</button></div>`).join('');
  return `<div class="modal-backdrop"><div class="modal market-editor"><div class="modal-head"><div><span class="eyebrow">MARKET EDITOR</span><h2>${state.editingMarketId ? '編輯賣場' : '建立賣場'}</h2></div><button class="close" data-action="close">×</button></div><div class="market-basic-grid"><div class="field"><label>賣場名稱</label><input id="market-name" value="${esc(draft.name)}" placeholder="例：三麗鷗聯名預購"/></div><div class="field"><label>收單截止日期</label><input id="market-closes-at" type="date" value="${esc(draft.closes_at)}"/></div></div><div class="field"><label>賣場說明</label><textarea id="market-description" rows="2">${esc(draft.description)}</textarea></div><div class="market-cover-compact"><span class="upload-thumb market-upload-thumb">${draft.file ? `<img src="${URL.createObjectURL(draft.file)}" alt="封面預覽"/>` : draft.image_url ? `<img src="${esc(draft.image_url)}" alt="封面預覽"/>` : 'COVER'}</span><label class="btn btn-light image-button">選擇封面<input id="market-image" type="file" accept="image/jpeg,image/png,image/webp,image/gif"/></label><label class="inline-check"><input id="market-remove-bg" type="checkbox" ${draft.removeBg ? 'checked' : ''}/> 自動去背</label><label class="check-field"><input id="market-active" type="checkbox" ${draft.is_active ? 'checked' : ''}/><span>立即上架</span></label></div><div class="editor-divider"><div><strong>商品／規格</strong><small>同一列完成名稱、成本、售價、數量與圖片</small></div><button class="btn btn-light" data-action="add-draft-item">＋ 新增選項</button></div><div class="item-editors compact-list">${rows || `<div class="empty">請先新增至少一個商品</div>`}</div><div class="editor-save-bar"><span>共 ${draft.products.length} 個商品</span><div class="editor-save-actions"><button class="btn btn-light" data-action="cancel-market">取消</button><button class="btn btn-primary" data-action="save-market" ${state.busy ? 'disabled' : ''}>${state.busy ? '儲存中…' : '儲存賣場與商品'}</button></div></div></div></div>`;
}

function modal() {
  if (state.modal === 'market-detail') return marketDetailModal();
  if (state.modal === 'cart') return cartModal();
  if (state.modal === 'auth') return authModal();
  if (state.modal === 'forgot') return forgotPasswordModal();
  if (state.modal === 'new-password') return newPasswordModal();
  if (state.modal === 'checkout') return checkoutModal();
  if (state.modal === 'success') return successModal();
  if (state.modal === 'market-editor') return marketEditorModal();
  if (state.modal === 'customer-editor') return customerEditorModal();
  return '';
}

function captureOpenDraft() {
  if (state.modal === 'market-editor' && document.querySelector('#market-name')) syncMarketDraftFromForm();
  if (state.modal === 'checkout' && document.querySelector('#customer')) persistCheckoutDraft();
  if (state.modal === 'customer-editor' && document.querySelector('#new-customer-name')) {
    state.customerDraft = {
      recipient_name: document.querySelector('#new-customer-name')?.value || '', phone: document.querySelector('#new-customer-phone')?.value || '',
      email: document.querySelector('#new-customer-email')?.value || '', delivery_method: document.querySelector('#new-customer-delivery')?.value || '面交取貨',
      admin_note: document.querySelector('#new-customer-note')?.value || '', is_regular: Boolean(document.querySelector('#new-customer-regular')?.checked), is_vip: Boolean(document.querySelector('#new-customer-vip')?.checked),
    };
  }
}

function render() {
  const keepModalStable = Boolean(state.modal && document.querySelector('.modal-backdrop'));
  const suppressRerenderMotion = Boolean(document.querySelector('#app')?.children.length);
  const previousModalScroll = document.querySelector('.modal')?.scrollTop || 0;
  const previousDetailScroll = document.querySelector('.detail-copy')?.scrollTop || 0;
  if (suppressRerenderMotion) document.body.classList.add('suppress-modal-motion');
  const content = state.view === 'shop' ? shop() : state.view === 'orders' ? ordersView() : adminView();
  document.querySelector('#app').innerHTML = `<div class="shell">${nav()}${content}${footer()}</div>${state.modal ? modal() : ''}`;
  document.body.classList.toggle('modal-open', Boolean(state.modal));
  bind();
  const nextModal = document.querySelector('.modal');
  const nextDetail = document.querySelector('.detail-copy');
  if (keepModalStable && nextModal) nextModal.scrollTop = previousModalScroll;
  if (keepModalStable && nextDetail) nextDetail.scrollTop = previousDetailScroll;
  if (suppressRerenderMotion) requestAnimationFrame(() => document.body.classList.remove('suppress-modal-motion'));
}

function bindModalScroll() {
  const backdrop = document.querySelector('.modal-backdrop');
  const modalElement = backdrop?.querySelector('.modal');
  if (!backdrop || !modalElement) return;
  const scrollTarget = modalElement.classList.contains('market-detail') ? modalElement.querySelector('.detail-copy') : modalElement;
  if (!scrollTarget) return;
  backdrop.addEventListener('wheel', (event) => {
    if (scrollTarget.contains(event.target)) return;
    scrollTarget.scrollTop += event.deltaY; event.preventDefault();
  }, { passive: false });
  let touchY = null;
  backdrop.addEventListener('touchstart', (event) => {
    touchY = scrollTarget.contains(event.target) ? null : event.touches[0]?.clientY ?? null;
  }, { passive: true });
  backdrop.addEventListener('touchmove', (event) => {
    if (touchY == null || !event.touches[0]) return;
    const nextY = event.touches[0].clientY; scrollTarget.scrollTop += touchY - nextY; touchY = nextY; event.preventDefault();
  }, { passive: false });
  backdrop.addEventListener('touchend', () => { touchY = null; }, { passive: true });
}

function previewSelectedImage(input) {
  const file = input.files?.[0];
  if (!file) return;
  const preview = input.closest('.market-cover-compact, .compact-image')?.querySelector('.upload-thumb');
  if (!preview) return;
  const image = document.createElement('img');
  image.src = URL.createObjectURL(file); image.alt = '圖片預覽';
  image.addEventListener('load', () => URL.revokeObjectURL(image.src), { once: true });
  preview.replaceChildren(image);
  syncMarketDraftFromForm();
}

function bindPointerSort(container, rowSelector, handleSelector, onSorted, keepWithinGroup = false) {
  if (!container) return;
  container.querySelectorAll(handleSelector).forEach((handle) => handle.addEventListener('pointerdown', (startEvent) => {
    if (handle.disabled) return;
    const dragged = handle.closest(rowSelector); if (!dragged) return;
    const group = dragged.dataset.sortGroup; let moved = false;
    startEvent.preventDefault(); dragged.classList.add('is-dragging');
    const move = (event) => {
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(rowSelector);
      if (!target || target === dragged || target.parentElement !== container) return;
      if (keepWithinGroup && target.dataset.sortGroup !== group) return;
      const rect = target.getBoundingClientRect();
      container.insertBefore(dragged, event.clientY > rect.top + rect.height / 2 ? target.nextSibling : target);
      moved = true;
      if (event.cancelable) event.preventDefault();
    };
    const end = () => {
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', end); document.removeEventListener('pointercancel', end);
      dragged.classList.remove('is-dragging');
      if (moved) onSorted([...container.querySelectorAll(rowSelector)]);
    };
    document.addEventListener('pointermove', move, { passive: false });
    document.addEventListener('pointerup', end, { once: true });
    document.addEventListener('pointercancel', end, { once: true });
  }));
}

function openMarket(id) {
  const market = state.markets.find((item) => item.id === id);
  if (!market) return;
  const first = market.products.find((item) => item.is_active && item.stock > 0) || market.products.find((item) => item.is_active);
  state.selectedMarketId = id; state.selectedProductId = first?.id || null; state.detailQty = 1; state.modal = 'market-detail'; render();
}

function updateDetailArtwork(product, market) {
  const media = document.querySelector('.detail-media'); if (!media) return;
  const current = media.querySelector('.detail-product-image,.detail-emoji');
  const source = product.image_url || market.image_url;
  if (!source) {
    const emoji = document.createElement('span'); emoji.className = 'detail-emoji'; emoji.textContent = market.emoji;
    current?.replaceWith(emoji); return;
  }
  if (current?.matches('img') && current.getAttribute('src') === source) return;
  const image = new Image(); let committed = false;
  const commit = () => {
    if (committed || state.selectedProductId !== product.id || !image.naturalWidth) return;
    committed = true;
    if (current?.matches('img')) {
      current.src = source; current.alt = product.name;
    } else {
      image.className = 'detail-product-image'; image.alt = product.name; current?.replaceWith(image);
    }
  };
  image.addEventListener('load', commit, { once: true });
  image.src = source;
  if (image.complete) commit();
}

function selectMarketItem(id) {
  const market = state.markets.find((item) => item.id === state.selectedMarketId);
  const product = market?.products.find((item) => item.id === id);
  if (!market || !product || !product.is_active || product.stock <= 0 || isClosed(market)) return;
  state.selectedProductId = id; state.detailQty = 1;
  document.querySelectorAll('[data-select-item]').forEach((button) => {
    const selected = button.dataset.selectItem === id;
    button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected));
  });
  const count = document.querySelector('[data-detail-count]'); if (count) count.textContent = '1';
  const total = document.querySelector('[data-detail-total]'); if (total) total.textContent = money(product.price);
  const minus = document.querySelector('[data-detail-qty="-1"]'); if (minus) minus.disabled = true;
  const plus = document.querySelector('[data-detail-qty="1"]'); if (plus) plus.disabled = product.stock <= 1;
  const add = document.querySelector('[data-action="add-selected-item"]');
  if (add) { add.disabled = false; add.textContent = '加入購物車'; }
  updateDetailArtwork(product, market);
}

function addSelectedItem() {
  const product = state.products.find((item) => item.id === state.selectedProductId);
  const market = state.markets.find((item) => item.id === product?.market_id);
  if (!product || !product.is_active || product.stock <= 0 || isClosed(market)) return;
  const existing = state.cart.find((item) => item.id === product.id);
  const nextQty = (existing?.qty || 0) + state.detailQty;
  if (nextQty > product.stock) { renderToast('已達目前可購買庫存'); return; }
  if (existing) existing.qty = nextQty;
  else state.cart.push({ id: product.id, product_id: product.id, market_id: product.market_id, market_name: product.market_name, name: product.name, price: Number(product.price), qty: state.detailQty, stock: product.stock });
  saveCart(); state.modal = 'cart'; render(); renderToast(`${product.name} 已加入購物車`);
}

function changeCartQuantity(id, delta) {
  const item = state.cart.find((entry) => entry.id === id); if (!item) return;
  const next = item.qty + delta;
  if (next < 1) { state.cart = state.cart.filter((entry) => entry.id !== id); saveCart(); render(); return; }
  if (next <= item.stock) item.qty = next;
  else { renderToast('已達目前可購買庫存'); return; }
  saveCart();
  const quantity = document.querySelector(`[data-cart-qty="${id}"]`); if (quantity) quantity.textContent = item.qty;
  const subtotal = document.querySelector(`[data-cart-subtotal="${id}"]`); if (subtotal) subtotal.textContent = money(Number(item.price) * item.qty);
  const plus = document.querySelector(`[data-cart-change="${id}"][data-delta="1"]`); if (plus) plus.disabled = item.qty >= item.stock;
  const total = document.querySelector('[data-cart-total]'); if (total) total.textContent = money(cartTotal());
  const badge = document.querySelector('.badge'); if (badge) badge.textContent = cartCount();
}

function changeDetailQuantity(delta) {
  const product = state.products.find((item) => item.id === state.selectedProductId); if (!product) return;
  state.detailQty = Math.max(1, Math.min(product.stock, state.detailQty + delta));
  const count = document.querySelector('[data-detail-count]'); if (count) count.textContent = state.detailQty;
  const total = document.querySelector('[data-detail-total]'); if (total) total.textContent = money(Number(product.price) * state.detailQty);
  const minus = document.querySelector('[data-detail-qty="-1"]'); if (minus) minus.disabled = state.detailQty <= 1;
  const plus = document.querySelector('[data-detail-qty="1"]'); if (plus) plus.disabled = state.detailQty >= product.stock;
}

async function signup() {
  const email = document.querySelector('#email')?.value.trim(); const password = document.querySelector('#password')?.value || '';
  if (!email || password.length < 6) { renderToast('請填寫 Email 及至少 6 個字元的密碼'); return; }
  state.busy = true; render();
  const { data, error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: `${window.location.origin}${window.location.pathname}` } });
  state.busy = false; if (error) { render(); renderToast(friendlyError(error)); return; }
  state.modal = null; render(); renderToast(data.session ? '註冊成功，已登入會員' : '註冊成功，請到信箱點擊驗證連結');
}

async function login() {
  const email = document.querySelector('#email')?.value.trim(); const password = document.querySelector('#password')?.value || '';
  if (!email || !password) { renderToast('請填寫信箱與密碼'); return; }
  state.busy = true; render(); const { error } = await supabase.auth.signInWithPassword({ email, password }); state.busy = false;
  if (error) { render(); renderToast(friendlyError(error)); return; }
  state.modal = null; state.view = 'orders'; render(); renderToast('登入成功');
}

async function sendRecovery() {
  const email = document.querySelector('#recover-email')?.value.trim(); if (!email) return;
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}${window.location.pathname}` });
  if (error) { renderToast(friendlyError(error)); return; } state.modal = null; render(); renderToast('重設信已寄出，請檢查 Email');
}

async function updatePassword() {
  const password = document.querySelector('#new-password')?.value || ''; const confirmation = document.querySelector('#confirm-password')?.value || '';
  if (password.length < 6 || password !== confirmation) { renderToast('請確認兩次輸入的密碼相同，且至少 6 個字元'); return; }
  const { error } = await supabase.auth.updateUser({ password }); if (error) { renderToast(friendlyError(error)); return; }
  state.modal = null; state.view = 'orders'; render(); renderToast('密碼更新成功');
}

async function checkout() {
  const recipient = document.querySelector('#customer')?.value.trim(); const phone = document.querySelector('#phone')?.value.trim();
  const delivery = document.querySelector('#delivery')?.value; const note = document.querySelector('#note')?.value.trim() || '';
  if (!recipient) { renderToast('請填寫收件人'); return; }
  if (state.checkoutMode === 'regular' && !state.checkoutDraft.customerId) { renderToast('請先選擇常客'); return; }
  state.busy = true; render();
  const items = state.cart.map((item) => ({ product_id: item.product_id, quantity: item.qty }));
  const request = isManager()
    ? supabase.rpc('admin_place_order', { p_customer_id: state.checkoutMode === 'regular' ? state.checkoutDraft.customerId : null, p_recipient_name: recipient, p_phone: phone, p_delivery_method: delivery, p_note: note, p_items: items })
    : supabase.rpc('place_order', { p_recipient_name: recipient, p_phone: phone, p_delivery_method: delivery, p_note: note, p_items: items });
  const { data: orderId, error } = await request;
  state.busy = false; if (error) { render(); renderToast(friendlyError(error)); return; }
  state.cart = []; saveCart(); state.checkoutDraft = {}; saveCheckoutDraft(); state.checkoutMode = 'general'; state.view = 'orders'; await Promise.all([loadOrders(), loadMarkets(), loadCustomers()]);
  state.lastOrder = state.orders.find((order) => order.id === orderId) || state.orders[0] || null; state.modal = 'success'; render();
}

async function prepareImage(file, removeBackground = false) {
  if (!file || !removeBackground || file.type === 'image/gif') return file;
  const bitmap = await createImageBitmap(file); const scale = Math.min(1, 1800 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas'); canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext('2d', { willReadFrequently: true }); context.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height); const data = pixels.data;
  for (let index = 0; index < data.length; index += 4) {
    const red = data[index]; const green = data[index + 1]; const blue = data[index + 2];
    const min = Math.min(red, green, blue); const max = Math.max(red, green, blue);
    if (min > 238 && max - min < 24) data[index + 3] = 0;
    else if (min > 215 && max - min < 30) data[index + 3] = Math.round(data[index + 3] * (238 - min) / 23);
  }
  context.putImageData(pixels, 0, 0);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png', .92));
  return new File([blob], `${file.name.replace(/\.[^.]+$/, '')}-nobg.png`, { type: 'image/png' });
}

async function uploadImage(originalFile, removeBackground = false) {
  const file = await prepareImage(originalFile, removeBackground);
  if (!file) return null;
  const allowed = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
  if (!allowed.has(file.type) || file.size > 5 * 1024 * 1024) throw new Error('圖片需為 JPG、PNG、WebP 或 GIF，且不能超過 5MB');
  const extension = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
  const path = `${state.user.id}/${crypto.randomUUID()}.${extension || 'jpg'}`;
  const { error } = await supabase.storage.from('product-images').upload(path, file, { contentType: file.type });
  if (error) throw error;
  return supabase.storage.from('product-images').getPublicUrl(path).data.publicUrl;
}

function syncMarketDraftFromForm() {
  const previous = new Map((state.marketDraft?.products || []).map((item) => [item.key, item]));
  state.marketDraft = {
    ...(state.marketDraft || {}),
    name: document.querySelector('#market-name')?.value.trim() || '',
    description: document.querySelector('#market-description')?.value.trim() || '',
    closes_at: document.querySelector('#market-closes-at')?.value || '',
    is_active: Boolean(document.querySelector('#market-active')?.checked),
    file: document.querySelector('#market-image')?.files?.[0] || state.marketDraft?.file || null,
    removeBg: Boolean(document.querySelector('#market-remove-bg')?.checked),
    products: [...document.querySelectorAll('[data-item-row]')].map((row, index) => {
      const key = row.dataset.key; const old = previous.get(key) || {};
      return { ...old, key, id: row.dataset.id || null, sort_order: index, name: row.querySelector('[data-item-name]')?.value.trim() || '', foreign_cost: row.querySelector('[data-item-foreign-cost]')?.value || '0', exchange_rate: row.querySelector('[data-item-exchange-rate]')?.value || '0', cost: row.querySelector('[data-item-cost]')?.value || '0', price: row.querySelector('[data-item-price]')?.value || '', stock: row.querySelector('[data-item-stock]')?.value || '0', is_active: row.querySelector('[data-item-active]')?.checked ?? true, file: row.querySelector('[data-item-image]')?.files?.[0] || old.file || null, removeBg: Boolean(row.querySelector('[data-item-remove-bg]')?.checked) };
    }),
  };
}

function autoCalculateLocalCost(row) {
  const foreignInput = row.querySelector('[data-item-foreign-cost]'); const rateInput = row.querySelector('[data-item-exchange-rate]'); const costInput = row.querySelector('[data-item-cost]');
  const foreignCost = Number(foreignInput?.value); const exchangeRate = Number(rateInput?.value); const localCost = Number(costInput?.value);
  if (costInput && localCost === 0 && foreignCost > 0 && exchangeRate > 0) costInput.value = String(Math.round(foreignCost * exchangeRate * 100) / 100);
}

function openMarketEditor(id = null) {
  if (!state.marketFeatureReady) { renderToast('請先執行賣場升級 SQL'); return; }
  const market = state.markets.find((item) => item.id === id); state.editingMarketId = id; state.marketDraft = createMarketDraft(market); state.modal = 'market-editor'; render();
}

async function saveMarket() {
  if (!isManager()) return;
  if (!state.costReady) { renderToast('請先在 Supabase 執行 product_cost_upgrade.sql'); return; }
  syncMarketDraftFromForm();
  const draft = state.marketDraft; const items = draft.products; const marketImage = draft.file;
  if (!draft.name || !draft.closes_at || !items.length) { renderToast('請填寫賣場名稱、截止日期，並建立至少一個品項'); return; }
  if (items.some((item) => !item.name || !Number.isFinite(Number(item.foreign_cost)) || Number(item.foreign_cost) < 0 || !Number.isFinite(Number(item.exchange_rate)) || Number(item.exchange_rate) < 0 || !Number.isFinite(Number(item.cost)) || Number(item.cost) < 0 || !Number.isFinite(Number(item.price)) || Number(item.price) < 0 || !Number.isInteger(Number(item.stock)) || Number(item.stock) < 0)) { renderToast('請正確填寫每個品項的外幣成本、匯率、成本、售價與數量'); return; }
  state.busy = true; render();
  try {
    const existing = state.markets.find((item) => item.id === state.editingMarketId);
    const coverUrl = await uploadImage(marketImage, draft.removeBg);
    const marketPayload = { name: draft.name, description: draft.description, is_active: draft.is_active, closes_at: new Date(`${draft.closes_at}T23:59:59`).toISOString() };
    if (coverUrl) marketPayload.image_url = coverUrl; else if (!existing) marketPayload.image_url = null;
    let marketId = existing?.id;
    if (existing) { const { error } = await supabase.from('markets').update(marketPayload).eq('id', existing.id); if (error) throw error; }
    else { const { data, error } = await supabase.from('markets').insert(marketPayload).select('id').single(); if (error) throw error; marketId = data.id; }

    for (const item of items) {
      const imageUrl = await uploadImage(item.file, item.removeBg);
      const payload = { market_id: marketId, name: item.name, description: item.description || '', price: Number(item.price), stock: Number(item.stock), is_active: item.is_active };
      if (state.sortingReady) payload.sort_order = Number(item.sort_order || 0);
      if (imageUrl) payload.image_url = imageUrl; else if (!item.id) payload.image_url = null;
      const result = item.id ? await supabase.from('products').update(payload).eq('id', item.id).select('id').single() : await supabase.from('products').insert(payload).select('id').single();
      if (result.error) throw result.error;
      const foreignCost = Number(item.foreign_cost); const exchangeRate = Number(item.exchange_rate); let localCost = Number(item.cost);
      if (localCost === 0 && foreignCost > 0 && exchangeRate > 0) localCost = Math.round(foreignCost * exchangeRate * 100) / 100;
      const { error: costError } = await supabase.rpc('admin_set_product_costs', { p_product_id: result.data.id, p_foreign_cost: foreignCost, p_exchange_rate: exchangeRate, p_cost: localCost, p_apply_to_unset_history: true });
      if (costError) throw costError;
    }
    await loadMarkets(); await loadProductCosts(); state.modal = null; state.marketDraft = null; state.editingMarketId = null; renderToast(existing ? '賣場與品項已更新' : '賣場已建立');
  } catch (error) { renderToast(friendlyError(error)); }
  finally { state.busy = false; render(); }
}

async function deleteProductFromEditor(key, productId) {
  if (!isManager()) return;
  syncMarketDraftFromForm();
  if (!productId) {
    state.marketDraft.products = state.marketDraft.products.filter((item) => item.key !== key);
    render(); return;
  }
  const product = state.marketDraft.products.find((item) => item.key === key);
  if (!window.confirm(`確定刪除「${product?.name || '這個商品'}」嗎？既有訂單紀錄會保留。`)) return;
  const preservedDraft = { ...state.marketDraft, products: state.marketDraft.products.filter((item) => item.key !== key) };
  const { error } = await supabase.from('products').delete().eq('id', productId);
  if (error) { renderToast(friendlyError(error)); return; }
  await loadMarkets(); await loadProductCosts();
  state.marketDraft = preservedDraft;
  render(); renderToast('商品已刪除');
}

async function deleteMarket(id) {
  if (!isManager()) return;
  const market = state.markets.find((entry) => entry.id === id); if (!market) return;
  const confirmed = window.confirm(`確定永久刪除「${market.name}」嗎？\n\n賣場內 ${market.products.length} 個商品也會一併刪除，既有訂單紀錄會保留。此操作無法復原。`);
  if (!confirmed) return;
  const { error } = await supabase.rpc('admin_delete_market', { p_market_id: id });
  if (error) {
    if (/admin_delete_market|schema cache|could not find/i.test(error.message || '')) renderToast('請先在 Supabase 執行 market_delete_upgrade.sql');
    else renderToast(friendlyError(error));
    return;
  }
  if (state.selectedMarketId === id) { state.selectedMarketId = null; state.selectedProductId = null; }
  await loadMarkets(); await loadProductCosts(); render(); renderToast('賣場與所屬商品已刪除');
}

async function toggleMarket(id) {
  const market = state.markets.find((item) => item.id === id); if (!market) return;
  const { error } = await supabase.from('markets').update({ is_active: !market.is_active }).eq('id', id);
  if (error) { renderToast(friendlyError(error)); return; } await loadMarkets(); render(); renderToast(market.is_active ? '賣場已下架' : '賣場已上架');
}

async function saveMarketOrder(rows) {
  if (!state.sortingReady || !isManager()) return;
  const ids = rows.map((row) => row.dataset.marketSort);
  const ordered = ids.map((id) => state.markets.find((market) => market.id === id)).filter(Boolean);
  state.markets = ordered;
  const results = await Promise.all(ordered.map((market, index) => supabase.from('markets').update({ sort_order: index }).eq('id', market.id)));
  const failed = results.find((result) => result.error);
  if (failed) { await loadMarkets(); render(); renderToast(friendlyError(failed.error)); return; }
  ordered.forEach((market, index) => { market.sort_order = index; });
  renderToast('賣場順序已儲存');
}

async function toggleMarketPin(id) {
  if (!state.sortingReady || !isManager()) { renderToast('請先執行 sorting_upgrade.sql'); return; }
  const market = state.markets.find((entry) => entry.id === id); if (!market) return;
  const { error } = await supabase.from('markets').update({ is_pinned: !market.is_pinned }).eq('id', id);
  if (error) { renderToast(friendlyError(error)); return; }
  await loadMarkets(); render(); renderToast(market.is_pinned ? '已取消置頂' : '賣場已置頂');
}

async function updateOrderStatus(id, status) {
  if (!isManager() || !statusLabels[status]) return;
  const { error } = await supabase.from('orders').update({ status }).eq('id', id); if (error) { renderToast(friendlyError(error)); return; }
  await loadOrders(); render(); renderToast('訂單狀態已更新');
}

async function updateOrderItemPrice(id) {
  if (!isManager() || !state.pricingReady) return;
  const input = document.querySelector(`[data-order-item-price="${id}"]`); const price = Number(input?.value);
  if (!Number.isFinite(price) || price < 0) { renderToast('請輸入正確的商品金額'); return; }
  const { error } = await supabase.rpc('admin_update_order_item_price', { p_order_item_id: id, p_unit_price: price });
  if (error) { renderToast(friendlyError(error)); return; }
  await loadOrders(); render(); renderToast('商品金額已更新，訂單總額已重新計算');
}

async function updateOrderItemQuantity(id) {
  if (!isManager() || !state.adminOpsReady) return;
  const input = document.querySelector(`[data-order-item-quantity="${id}"]`); const quantity = Number(input?.value);
  if (!Number.isInteger(quantity) || quantity < 0) { renderToast('數量必須是 0 或正整數'); return; }
  const { error } = await supabase.rpc('admin_update_order_item_quantity', { p_order_item_id: id, p_quantity: quantity });
  if (error) { renderToast(friendlyError(error)); return; }
  await Promise.all([loadOrders(), loadMarkets()]); await loadProductCosts(); render(); renderToast(quantity === 0 ? '訂單品項已刪除，數量已補回庫存' : '商品數量與庫存已同步更新');
}

async function deleteOrder(id) {
  if (!window.confirm('確定永久刪除這張訂單嗎？商品數量會補回庫存。')) return;
  const { error } = await supabase.rpc('admin_delete_order', { p_order_id: id });
  if (error) { renderToast(friendlyError(error)); return; }
  await Promise.all([loadOrders(), loadMarkets()]); await loadProductCosts(); render(); renderToast('訂單已刪除，庫存已補回');
}

async function deleteCustomer(id) {
  if (!window.confirm('確定刪除這位購買人／常客嗎？既有訂單仍會保留。')) return;
  const { error } = await supabase.from('customers').delete().eq('id', id);
  if (error) { renderToast(friendlyError(error)); return; }
  await loadCustomers(); render(); renderToast('客戶資料已刪除');
}

async function toggleProcurement(productId, checked) {
  const { error } = await supabase.from('procurement_checks').upsert({ product_id: productId, is_purchased: checked, updated_by: state.user.id });
  if (error) { renderToast(friendlyError(error)); return; }
  await loadProcurementChecks(); render(); renderToast(checked ? '已標記採購完成' : '已移回待採購');
}

async function createCustomer() {
  const payload = {
    recipient_name: document.querySelector('#new-customer-name')?.value.trim(),
    phone: document.querySelector('#new-customer-phone')?.value.trim(),
    email: document.querySelector('#new-customer-email')?.value.trim() || null,
    delivery_method: document.querySelector('#new-customer-delivery')?.value,
    admin_note: document.querySelector('#new-customer-note')?.value.trim() || '',
    is_regular: Boolean(document.querySelector('#new-customer-regular')?.checked),
    is_vip: Boolean(document.querySelector('#new-customer-vip')?.checked),
  };
  if (!payload.recipient_name) { renderToast('請填寫常客姓名'); return; }
  const { error } = await supabase.from('customers').insert(payload); if (error) { renderToast(friendlyError(error)); return; }
  await loadCustomers(); state.modal = null; state.customerDraft = null; render(); renderToast('常客已建立');
}

async function saveCustomer(id) {
  const row = document.querySelector(`[data-customer-row="${id}"]`); if (!row) return;
  const payload = { recipient_name: row.querySelector('[data-customer-name]').value.trim(), email: row.querySelector('[data-customer-email]').value.trim() || null, phone: row.querySelector('[data-customer-phone]').value.trim(), delivery_method: row.querySelector('[data-customer-delivery]').value, is_regular: row.querySelector('[data-customer-regular]').checked, is_vip: row.querySelector('[data-customer-vip]').checked, admin_note: row.querySelector('[data-customer-note]').value.trim() };
  if (!payload.recipient_name) { renderToast('收件人不能留白'); return; }
  const { error } = await supabase.from('customers').update(payload).eq('id', id); if (error) { renderToast(friendlyError(error)); return; }
  await loadCustomers(); render(); renderToast('客戶資料已更新');
}

function persistCheckoutDraft() {
  state.checkoutDraft = { ...state.checkoutDraft, recipient: document.querySelector('#customer')?.value || '', phone: document.querySelector('#phone')?.value || '', delivery: document.querySelector('#delivery')?.value || '面交取貨', note: document.querySelector('#note')?.value || '' };
  saveCheckoutDraft();
}

function selectRegularCustomer(id) {
  const customer = state.customers.find((item) => item.id === id);
  state.checkoutDraft = customer ? { customerId: customer.id, recipient: customer.recipient_name, phone: customer.phone, delivery: customer.delivery_method, note: state.checkoutDraft.note || '' } : { ...state.checkoutDraft, customerId: null };
  saveCheckoutDraft(); render();
}

function safeSheetName(name, usedNames) {
  const base = `${name}_商品清單`.replace(/[\\/?*\[\]:]/g, '').slice(0, 31) || '賣場商品清單';
  let result = base; let number = 2;
  while (usedNames.has(result)) { const suffix = `_${number++}`; result = `${base.slice(0, 31 - suffix.length)}${suffix}`; }
  usedNames.add(result); return result;
}

async function exportExcel() {
  try {
    const XLSX = await import('https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs');
    const workbook = XLSX.utils.book_new(); const usedNames = new Set(['訂單']);
    const orderRows = state.orders.flatMap((order) => (order.order_items || []).map((item) => {
      const product = state.products.find((entry) => entry.id === item.product_id); const unitCost = Number(item.unit_cost ?? product?.cost ?? 0); const quantity = Number(item.quantity);
      return { 訂單編號: order.order_number, 下單帳號: order.account_email || '未記錄', 日期: new Date(order.created_at).toLocaleString('zh-TW'), 收件人: order.recipient_name,
        電話: order.phone, 取貨方式: order.delivery_method, 商品品項: item.product_name, 數量: quantity,
        單件成本: unitCost, 售價: Number(item.unit_price), 成本合計: unitCost * quantity, 銷售小計: Number(item.subtotal),
        商品獲利: (Number(item.unit_price) - unitCost) * quantity, 原始售價: item.original_unit_price == null ? Number(item.unit_price) : Number(item.original_unit_price),
        人工改價: item.original_unit_price == null ? '否' : '是', 訂單總額: Number(order.total_amount), 狀態: statusLabels[order.status] || order.status, 備註: order.note || '' };
    }));
    const ordersSheet = XLSX.utils.json_to_sheet(orderRows.length ? orderRows : [{ 提示: '目前沒有訂單' }]); ordersSheet['!cols'] = [{ wch: 18 }, { wch: 28 }, { wch: 20 }, { wch: 14 }, { wch: 16 }, { wch: 20 }, { wch: 28 }, { wch: 8 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 24 }];
    XLSX.utils.book_append_sheet(workbook, ordersSheet, '訂單');
    const shipmentRows = shipmentSummaries().flatMap((recipient) => recipient.items.map((item) => ({ 收件人: recipient.recipient, 下單帳號: recipient.account, 聯絡電話: recipient.phone, 取貨方式: recipient.delivery, 訂購商品: item.name, 數量: item.quantity, 金額: item.amount, 獲利: item.profit })));
    const shipmentSheet = XLSX.utils.json_to_sheet(shipmentRows.length ? shipmentRows : [{ 提示: '目前沒有發貨資料' }]);
    shipmentSheet['!cols'] = [{ wch: 14 }, { wch: 28 }, { wch: 16 }, { wch: 20 }, { wch: 32 }, { wch: 10 }, { wch: 14 }, { wch: 14 }];
    XLSX.utils.book_append_sheet(workbook, shipmentSheet, '發貨清單');
    for (const { market, rows } of marketSummaries(true)) {
      const data = rows.map((row) => ({ 商品品項: row.product.name, 訂購總數量: row.quantity, 外幣成本: Number(row.product.foreign_cost || 0), 匯率: Number(row.product.exchange_rate || 0), 單件成本: row.cost, 售價: row.price, 成本合計: row.totalCost, 銷售合計: row.revenue, 購買人數: row.buyers, 商品獲利: row.profit, 已採購: row.procured ? '是' : '否', 目前後台庫存: Number(row.product.stock) }));
      const sheet = XLSX.utils.json_to_sheet(data); sheet['!cols'] = [{ wch: 32 }, { wch: 14 }, { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 14 }, { wch: 10 }, { wch: 16 }];
      XLSX.utils.book_append_sheet(workbook, sheet, safeSheetName(market.name, usedNames));
    }
    XLSX.writeFile(workbook, `NewShop訂單-${new Date().toLocaleDateString('en-CA')}.xlsx`);
  } catch (error) { renderToast(`Excel 產生失敗：${friendlyError(error)}`); }
}

function bind() {
  bindModalScroll();
  document.querySelector('.modal-backdrop')?.addEventListener('click', (event) => {
    if (event.target !== event.currentTarget || state.modal !== 'cart') return;
    state.modal = null; state.view = 'shop'; render();
  });
  document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', async () => { state.view = button.dataset.view; if (state.view === 'admin') state.adminTab = 'markets'; if ((state.view === 'orders' || state.view === 'admin') && state.user) { await Promise.all([loadOrders(), loadMarkets(), loadCustomers(), loadProcurementChecks()]); await loadProductCosts(); } render(); }));
  document.querySelectorAll('[data-scroll]').forEach((button) => button.addEventListener('click', () => { const target = button.dataset.scroll; if (state.view !== 'shop') { state.view = 'shop'; render(); requestAnimationFrame(() => document.querySelector(`#${target}`)?.scrollIntoView({ behavior: 'smooth' })); } else document.querySelector(`#${target}`)?.scrollIntoView({ behavior: 'smooth' }); }));
  document.querySelectorAll('[data-open-market]').forEach((button) => button.addEventListener('click', () => openMarket(button.dataset.openMarket)));
  document.querySelectorAll('[data-select-item]').forEach((button) => button.addEventListener('click', () => selectMarketItem(button.dataset.selectItem)));
  document.querySelectorAll('[data-detail-qty]').forEach((button) => button.addEventListener('click', () => changeDetailQuantity(Number(button.dataset.detailQty))));
  document.querySelector('[data-action="add-selected-item"]')?.addEventListener('click', addSelectedItem);
  document.querySelector('[data-action="cart"]')?.addEventListener('click', () => { state.modal = 'cart'; render(); });
  document.querySelectorAll('[data-remove]').forEach((button) => button.addEventListener('click', () => { state.cart = state.cart.filter((item) => item.id !== button.dataset.remove); saveCart(); render(); }));
  document.querySelectorAll('[data-cart-change]').forEach((button) => button.addEventListener('click', () => changeCartQuantity(button.dataset.cartChange, Number(button.dataset.delta))));
  document.querySelectorAll('[data-action="close"]').forEach((button) => button.addEventListener('click', () => { state.modal = null; render(); }));
  document.querySelectorAll('[data-modal]').forEach((button) => button.addEventListener('click', () => { state.authMode = 'login'; state.modal = button.dataset.modal; render(); }));
  document.querySelectorAll('[data-auth-mode]').forEach((button) => button.addEventListener('click', () => { state.authMode = button.dataset.authMode; render(); }));
  document.querySelector('[data-action="signup"]')?.addEventListener('click', signup); document.querySelector('[data-action="login"]')?.addEventListener('click', login);
  document.querySelector('[data-action="forgot-password"]')?.addEventListener('click', () => { state.modal = 'forgot'; render(); });
  document.querySelector('[data-action="back-login"]')?.addEventListener('click', () => { state.modal = 'auth'; state.authMode = 'login'; render(); });
  document.querySelector('[data-action="send-recovery"]')?.addEventListener('click', sendRecovery); document.querySelector('[data-action="update-password"]')?.addEventListener('click', updatePassword);
  document.querySelector('[data-action="logout"]')?.addEventListener('click', async () => { await supabase.auth.signOut(); state.view = 'shop'; render(); renderToast('已登出'); });
  document.querySelector('[data-action="begin-checkout"]')?.addEventListener('click', () => { if (!state.user) { state.authMode = 'login'; state.modal = 'auth'; render(); renderToast('請先登入，再送出訂單'); return; } state.modal = 'checkout'; render(); });
  document.querySelector('[data-action="checkout"]')?.addEventListener('click', checkout);
  document.querySelectorAll('#customer,#phone,#delivery,#note').forEach((input) => input.addEventListener('input', persistCheckoutDraft));
  document.querySelectorAll('#market-name,#market-description,#market-closes-at,#market-active,#market-remove-bg,[data-item-name],[data-item-foreign-cost],[data-item-exchange-rate],[data-item-cost],[data-item-price],[data-item-stock],[data-item-active],[data-item-remove-bg]').forEach((input) => input.addEventListener('input', syncMarketDraftFromForm));
  document.querySelectorAll('#new-customer-name,#new-customer-phone,#new-customer-email,#new-customer-delivery,#new-customer-note,#new-customer-regular,#new-customer-vip').forEach((input) => input.addEventListener('input', captureOpenDraft));
  document.querySelectorAll('[data-checkout-mode]').forEach((button) => button.addEventListener('click', () => { persistCheckoutDraft(); state.checkoutMode = button.dataset.checkoutMode; if (state.checkoutMode === 'general') state.checkoutDraft.customerId = null; saveCheckoutDraft(); render(); }));
  document.querySelector('#regular-customer')?.addEventListener('change', (event) => selectRegularCustomer(event.target.value));
  document.querySelector('[data-action="view-orders"]')?.addEventListener('click', () => { state.modal = null; state.view = 'orders'; render(); });
  document.querySelector('[data-action="continue-shopping"]')?.addEventListener('click', () => { state.modal = null; state.view = 'shop'; render(); });
  document.querySelector('[data-action="export"]')?.addEventListener('click', exportExcel);
  document.querySelectorAll('[data-admin-tab]').forEach((button) => button.addEventListener('click', () => { state.adminTab = button.dataset.adminTab; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); }));
  document.querySelectorAll('[data-order-history]').forEach((button) => button.addEventListener('click', () => { state.adminOrderHistory = button.dataset.orderHistory === 'history'; render(); }));
  document.querySelectorAll('[data-procurement-history]').forEach((button) => button.addEventListener('click', () => { state.procurementHistory = button.dataset.procurementHistory === 'history'; render(); }));
  document.querySelectorAll('[data-procurement-product]').forEach((input) => input.addEventListener('change', () => toggleProcurement(input.dataset.procurementProduct, input.checked)));
  document.querySelector('[data-action="new-customer"]')?.addEventListener('click', () => { state.customerDraft = null; state.modal = 'customer-editor'; render(); });
  document.querySelector('[data-action="create-customer"]')?.addEventListener('click', createCustomer);
  document.querySelectorAll('[data-save-customer]').forEach((button) => button.addEventListener('click', () => saveCustomer(button.dataset.saveCustomer)));
  document.querySelectorAll('[data-delete-customer]').forEach((button) => button.addEventListener('click', () => deleteCustomer(button.dataset.deleteCustomer)));
  document.querySelector('[data-action="new-market"]')?.addEventListener('click', () => openMarketEditor());
  document.querySelectorAll('[data-edit-market]').forEach((button) => button.addEventListener('click', () => openMarketEditor(button.dataset.editMarket)));
  document.querySelectorAll('[data-toggle-market]').forEach((button) => button.addEventListener('click', () => toggleMarket(button.dataset.toggleMarket)));
  document.querySelectorAll('[data-delete-market]').forEach((button) => button.addEventListener('click', () => deleteMarket(button.dataset.deleteMarket)));
  document.querySelectorAll('[data-pin-market]').forEach((button) => button.addEventListener('click', () => toggleMarketPin(button.dataset.pinMarket)));
  bindPointerSort(document.querySelector('#market-sort-list'), '[data-market-sort]', '[data-market-drag]', saveMarketOrder, true);
  document.querySelector('[data-action="add-draft-item"]')?.addEventListener('click', () => { syncMarketDraftFromForm(); state.marketDraft.products.push({ key: crypto.randomUUID(), sort_order: state.marketDraft.products.length, name: '', foreign_cost: 0, exchange_rate: 0, cost: 0, price: '', stock: 0, is_active: true, file: null, removeBg: false }); render(); });
  document.querySelectorAll('[data-remove-draft-item]').forEach((button) => button.addEventListener('click', () => deleteProductFromEditor(button.dataset.removeDraftItem, button.dataset.productId)));
  bindPointerSort(document.querySelector('.item-editors'), '[data-item-row]', '[data-item-drag]', (rows) => { rows.forEach((row, index) => { const handle = row.querySelector('[data-item-drag]'); if (handle) handle.textContent = index + 1; }); syncMarketDraftFromForm(); });
  document.querySelector('#market-image')?.addEventListener('change', (event) => previewSelectedImage(event.currentTarget));
  document.querySelectorAll('[data-item-image]').forEach((input) => input.addEventListener('change', (event) => previewSelectedImage(event.currentTarget)));
  document.querySelectorAll('[data-item-foreign-cost],[data-item-exchange-rate]').forEach((input) => input.addEventListener('change', () => autoCalculateLocalCost(input.closest('[data-item-row]'))));
  document.querySelector('[data-action="cancel-market"]')?.addEventListener('click', () => { state.modal = null; state.marketDraft = null; state.editingMarketId = null; render(); });
  document.querySelector('[data-action="save-market"]')?.addEventListener('click', saveMarket);
  document.querySelectorAll('[data-order-status]').forEach((select) => select.addEventListener('change', () => updateOrderStatus(select.dataset.orderStatus, select.value)));
  document.querySelectorAll('[data-save-item-quantity]').forEach((button) => button.addEventListener('click', () => updateOrderItemQuantity(button.dataset.saveItemQuantity)));
  document.querySelectorAll('[data-save-item-price]').forEach((button) => button.addEventListener('click', () => updateOrderItemPrice(button.dataset.saveItemPrice)));
  document.querySelectorAll('[data-delete-order]').forEach((button) => button.addEventListener('click', () => deleteOrder(button.dataset.deleteOrder)));
}

function startBrandIntro() {
  const intro = document.querySelector('#brand-intro'); if (!intro) return;
  const play = () => {
    if (document.hidden) { document.addEventListener('visibilitychange', play, { once: true }); return; }
    requestAnimationFrame(() => intro.classList.add('is-playing'));
    intro.addEventListener('animationend', (event) => { if (event.target === intro) intro.remove(); });
    window.setTimeout(() => intro.remove(), 3400);
  };
  if (document.readyState === 'complete') play();
  else window.addEventListener('load', play, { once: true });
}

document.addEventListener('visibilitychange', () => { if (document.hidden) captureOpenDraft(); });
startBrandIntro();
render();
initialize();
