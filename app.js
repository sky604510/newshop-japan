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
  authMode: 'login', loading: true, busy: false, toast: '', marketFeatureReady: true, operationsReady: true,
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

function renderToast(message) {
  state.toast = message; render();
  window.setTimeout(() => { state.toast = ''; render(); }, 2600);
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
    products: (market.products || []).sort((a, b) => new Date(a.created_at) - new Date(b.created_at)),
    emoji: ['🎀', '🌸', '🍭', '🪞', '💝'][marketIndex % 5],
  })).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || new Date(a.created_at) - new Date(b.created_at));
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
    .select('id,slug,name,description,image_url,is_active,sort_order,closes_at,created_at,products(id,market_id,name,description,price,image_url,stock,is_active,created_at)')
    .order('sort_order').order('created_at');
  if (marketQuery.error && /closes_at/i.test(marketQuery.error.message || '')) {
    state.operationsReady = false;
    marketQuery = await supabase.from('markets')
      .select('id,slug,name,description,image_url,is_active,sort_order,created_at,products(id,market_id,name,description,price,image_url,stock,is_active,created_at)')
      .order('sort_order').order('created_at');
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
      is_active: true, sort_order: 0, created_at: new Date(0).toISOString(), products: data || [],
    }]);
  }
  syncCartWithProducts();
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
    .select('id,order_number,user_id,customer_id,recipient_name,phone,delivery_method,note,status,total_amount,created_at,order_items(id,product_id,market_id,product_name,unit_price,quantity,subtotal)')
    .order('created_at', { ascending: false });
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
  try { await loadProfile(); await Promise.all([loadOrders(), loadMarkets(), loadCustomers()]); }
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
  syncSession(session);
}, 0));

function nav() {
  const admin = isManager() ? `<button class="${state.view === 'admin' ? 'active' : ''}" data-view="admin">管理員後台</button>` : '';
  const member = state.user ? esc(state.user.email || '會員') : '登入';
  return `<header class="nav"><button class="brand" data-view="shop"><img class="brand-logo" src="./assets/newshop-logo.png" alt="NewShop Logo"/><span>NewShop日本連線代購<small>JAPAN SELECT SHOP</small></span></button><nav class="navlinks"><button class="${state.view === 'shop' ? 'active' : ''}" data-view="shop">逛賣場</button><button data-scroll="guide">購物須知</button><button class="${state.view === 'orders' ? 'active' : ''}" data-view="orders">${member}</button>${admin}<button class="cart-btn" data-action="cart">購物車 <span class="badge">${cartCount()}</span></button></nav></header>`;
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
  return `<article class="market-card reveal" style="--delay:${Math.min(index * 70, 280)}ms"><button class="market-cover" data-open-market="${market.id}" aria-label="查看 ${esc(market.name)}">${art}<span class="market-pill">DROP ${String(index + 1).padStart(2, '0')}</span><span class="market-arrow">↗</span></button><div class="market-copy"><div class="market-meta"><span>${items.length} ITEMS</span><span>${closed ? 'ORDER CLOSED' : soldOut ? 'SOLD OUT' : 'AVAILABLE NOW'}</span></div><h3>${esc(market.name)}</h3><p>${esc(market.description || '精選日本限定商品。')}</p>${market.closes_at ? `<div class="deadline">收單至 ${new Date(market.closes_at).toLocaleDateString('zh-TW')}</div>` : ''}<div class="market-bottom"><strong>${marketPrice(market)}</strong><button class="text-link" data-open-market="${market.id}">${unavailable ? (closed ? '已截止・查看商品' : '無庫存・查看商品') : '進入賣場 →'}</button></div></div></article>`;
}

function shop() {
  const markets = state.markets.filter((market) => market.is_active);
  const cards = state.loading ? `<div class="empty">正在同步日本連線賣場…</div>` : markets.length ? markets.map(marketCard).join('') : `<div class="empty">目前沒有上架賣場</div>`;
  return `<main><section id="markets" class="catalog-first"><div class="catalog-head compact"><span class="catalog-number">${String(markets.length).padStart(2, '0')}</span><div><span class="eyebrow">NEWSHOP SELECTED MARKETS</span><h1>目前開放賣場</h1></div><p>日本連線選物・點進賣場選擇品項</p></div><div class="markets-grid">${cards}</div></section><section id="guide" class="guide compact-guide"><div class="guide-title"><span>HOW TO ORDER</span><h2>簡單三步驟</h2></div><div class="guide-grid"><article><span>01</span><h3>進入賣場</h3><p>查看各賣場的品項與收單期限。</p></article><article><span>02</span><h3>加入購物車</h3><p>選擇品項和數量，售完會直接顯示無庫存。</p></article><article><span>03</span><h3>登入送單</h3><p>送出後可隨時查詢訂單進度。</p></article></div></section></main>`;
}

function orderRow(order) {
  const items = order.order_items || [];
  return `<div class="order"><div><strong>${esc(order.order_number)}</strong><div class="order-items">${items.map((item) => `${esc(item.product_name)} × ${item.quantity}`).join('、')}</div><small>${new Date(order.created_at).toLocaleString('zh-TW')}</small></div><div class="order-price"><strong>${money(order.total_amount)}</strong><div class="status">${statusLabels[order.status] || esc(order.status)}</div></div></div>`;
}

function ordersView() {
  if (!state.user) return `<main class="split"><section class="panel"><span class="eyebrow">MEMBER AREA</span><h2>登入後查看訂單</h2><p>使用信箱建立帳號，就能跨裝置查詢訂購進度。</p><button class="btn btn-primary" data-modal="auth">登入／註冊</button></section><section class="panel"><h2>訂單紀錄</h2><div class="empty">登入後顯示你的訂單</div></section></main>`;
  return `<main class="split"><section class="panel member-card"><span class="eyebrow">MEMBER AREA</span><h2>我的訂單</h2><p>${esc(state.user.email)}</p><button class="btn btn-primary" data-action="logout">登出</button></section><section class="panel"><h2>訂單紀錄</h2>${state.orders.length ? state.orders.map(orderRow).join('') : `<div class="empty">目前還沒有訂單<br/><button class="btn btn-accent" data-view="shop">去逛逛</button></div>`}</section></main>`;
}

function marketSummaries(includeZero = false) {
  return state.markets.map((market) => ({
    market,
    rows: market.products.map((product) => {
      const itemOrders = state.orders.filter((order) => order.status !== 'cancelled').flatMap((order) =>
        (order.order_items || []).filter((item) => item.product_id === product.id || (item.market_id === market.id && item.product_name === product.name)).map((item) => ({ ...item, order })),
      );
      return { product, quantity: itemOrders.reduce((sum, item) => sum + Number(item.quantity), 0), buyers: new Set(itemOrders.map((item) => item.order.customer_id || item.order.phone)).size };
    }).filter((row) => includeZero || row.quantity > 0),
  })).filter((entry) => includeZero || entry.rows.length);
}

function latestCustomerOrder(customer) {
  return state.orders.find((order) => order.customer_id === customer.id || (!order.customer_id && order.phone === customer.phone));
}

function adminView() {
  if (!isManager()) return `<main class="panel admin-page"><div class="empty">這個頁面只開放管理員</div></main>`;
  const total = state.orders.filter((order) => order.status !== 'cancelled').reduce((sum, order) => sum + Number(order.total_amount), 0);
  const statusOptions = (current) => Object.entries(statusLabels).map(([value, label]) => `<option value="${value}" ${current === value ? 'selected' : ''}>${label}</option>`).join('');
  const orderRows = state.orders.map((order) => `<tr><td>${esc(order.order_number)}</td><td>${esc(order.recipient_name)}<br/><small>${esc(order.phone)}・${esc(order.delivery_method)}</small></td><td>${(order.order_items || []).map((item) => `${esc(item.product_name)} × ${item.quantity}`).join('<br/>')}</td><td>${money(order.total_amount)}</td><td><select data-order-status="${order.id}">${statusOptions(order.status)}</select></td></tr>`).join('');
  const marketRows = state.markets.map((market) => { const cover = market.image_url || market.products.find((item) => item.image_url)?.image_url; return `<tr><td><div class="admin-market"><span class="admin-thumb">${cover ? `<img src="${esc(cover)}" alt=""/>` : market.emoji}</span><span><strong>${esc(market.name)}</strong><small>${market.is_active ? '已上架' : '已下架'}・${market.closes_at ? `收單 ${new Date(market.closes_at).toLocaleDateString('zh-TW')}` : '未設定期限'}</small></span></div></td><td>${market.products.length}</td><td>${market.products.reduce((sum, item) => sum + Number(item.stock), 0)}</td><td><div class="admin-actions"><button class="btn btn-light" data-edit-market="${market.id}">編輯</button><button class="btn ${market.is_active ? 'btn-danger-soft' : 'btn-accent'}" data-toggle-market="${market.id}">${market.is_active ? '下架' : '上架'}</button></div></td></tr>`; }).join('');
  const customerRows = state.customers.map((customer) => { const latest = latestCustomerOrder(customer); const latestItem = latest ? (latest.order_items || []).map((item) => item.product_name).join('、') : '尚未下單'; return `<tr data-customer-row="${customer.id}"><td><input data-customer-name value="${esc(customer.recipient_name)}"/><small>${esc(customer.email || '未綁定會員信箱')}</small></td><td><input data-customer-phone value="${esc(customer.phone)}"/></td><td><select data-customer-delivery>${deliverySelect(customer.delivery_method)}</select></td><td>${esc(latestItem)}${latest ? `<small>${new Date(latest.created_at).toLocaleDateString('zh-TW')}</small>` : ''}</td><td><label class="table-check"><input data-customer-regular type="checkbox" ${customer.is_regular ? 'checked' : ''}/>常客</label><label class="table-check vip"><input data-customer-vip type="checkbox" ${customer.is_vip ? 'checked' : ''}/>VIP</label></td><td><input data-customer-note value="${esc(customer.admin_note)}" placeholder="內部備註"/></td><td><button class="btn btn-light" data-save-customer="${customer.id}">儲存</button></td></tr>`; }).join('');
  const summaries = marketSummaries();
  const summaryHtml = summaries.length ? summaries.map(({ market, rows }) => `<article class="summary-card"><div class="summary-head"><h3>${esc(market.name)}</h3><span>${rows.reduce((sum, row) => sum + row.quantity, 0)} 件</span></div><table class="admin-table"><thead><tr><th>商品品項</th><th>訂購數量</th><th>購買人數</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${esc(row.product.name)}</td><td><strong>${row.quantity}</strong></td><td>${row.buyers}</td></tr>`).join('')}</tbody></table></article>`).join('') : `<div class="empty">目前沒有可統計的有效訂單</div>`;
  const migrationNotice = state.operationsReady ? '' : `<div class="setup-notice">請到 Supabase SQL Editor 執行最新的 <strong>customer_operations_upgrade.sql</strong>，才能使用常客、VIP、截止日與代下單。</div>`;
  return `<main class="admin-page">${migrationNotice}<section class="panel"><div class="section-head"><div><span class="eyebrow">ADMIN CONSOLE</span><h2>訂單總覽</h2><p>${esc(state.user?.email)} ・ 管理員</p></div><button class="btn btn-primary" data-action="export">下載 Excel 報表</button></div><div class="admin-stats"><div class="stat"><small>總訂單</small><strong>${state.orders.length}</strong></div><div class="stat"><small>待處理</small><strong>${state.orders.filter((order) => order.status === 'pending').length}</strong></div><div class="stat"><small>有效訂單總額</small><strong>${money(total)}</strong></div></div>${state.orders.length ? `<div class="table-wrap"><table class="admin-table"><thead><tr><th>訂單編號</th><th>收件資訊</th><th>品項</th><th>金額</th><th>狀態</th></tr></thead><tbody>${orderRows}</tbody></table></div>` : `<div class="empty">還沒有訂單</div>`}</section><section class="panel"><div class="section-head"><div><span class="eyebrow">PURCHASE SUMMARY</span><h2>各賣場採購統計</h2><p>取消訂單不列入，方便現場直接依品項採購。</p></div></div><div class="summary-grid">${summaryHtml}</div></section><section class="panel"><div class="section-head"><div><span class="eyebrow">CUSTOMERS</span><h2>購買人與常客清單</h2><p>常客可在管理員結帳時快速帶入收件資料。</p></div><button class="btn btn-accent" data-action="new-customer" ${state.operationsReady ? '' : 'disabled'}>＋ 新增常客</button></div>${state.customers.length ? `<div class="table-wrap"><table class="admin-table customer-table"><thead><tr><th>收件人</th><th>電話</th><th>取貨方式</th><th>最近商品</th><th>標籤</th><th>備註</th><th></th></tr></thead><tbody>${customerRows}</tbody></table></div>` : `<div class="empty">尚無買家資料；會員完成第一筆訂單後會自動建立。</div>`}</section><section class="panel"><div class="section-head"><div><span class="eyebrow">MARKETS & ITEMS</span><h2>賣場管理</h2><p>封面縮圖、截止日和各品項都可在這裡調整。</p></div><button class="btn btn-accent" data-action="new-market" ${state.marketFeatureReady ? '' : 'disabled'}>＋ 建立賣場</button></div>${state.markets.length ? `<div class="table-wrap"><table class="admin-table"><thead><tr><th>賣場</th><th>品項數</th><th>總庫存</th><th>操作</th></tr></thead><tbody>${marketRows}</tbody></table></div>` : `<div class="empty">尚未建立賣場</div>`}</section></main>`;
}

function footer() { return `<footer><strong>NewShop日本連線代購</strong><span><a href="mailto:sky604510@gmail.com">sky604510@gmail.com</a> ・ 會員與訂單由 Supabase 安全保存</span></footer>`; }

function marketDetailModal() {
  const market = state.markets.find((item) => item.id === state.selectedMarketId);
  if (!market) return '';
  const items = market.products.filter((item) => item.is_active);
  const selected = items.find((item) => item.id === state.selectedProductId) || items.find((item) => item.stock > 0) || items[0];
  const cover = selected?.image_url || market.image_url;
  const art = cover ? `<img src="${esc(cover)}" alt="${esc(market.name)}" />` : `<span class="detail-emoji">${market.emoji}</span>`;
  const closed = isClosed(market);
  return `<div class="modal-backdrop"><div class="modal market-detail"><button class="close detail-close" data-action="close">×</button><div class="detail-media">${art}<span class="market-pill">${esc(market.name)}</span></div><div class="detail-copy"><span class="eyebrow">SELECT YOUR ITEM</span><h2>${esc(market.name)}</h2><p>${esc(market.description)}</p>${market.closes_at ? `<div class="deadline ${closed ? 'closed' : ''}">${closed ? '此賣場已截止收單' : `收單至 ${new Date(market.closes_at).toLocaleDateString('zh-TW')}`}</div>` : ''}<div class="item-label">品項 <small>每款價格獨立計算</small></div><div class="item-options">${items.map((item) => `<button class="item-option ${selected?.id === item.id ? 'selected' : ''}" data-select-item="${item.id}" ${item.stock <= 0 || closed ? 'disabled' : ''}><span>${esc(item.name)}</span><strong>${money(item.price)}</strong><small>${item.stock > 0 && !closed ? '可購買' : '無庫存'}</small></button>`).join('')}</div>${selected ? `<div class="detail-buy"><div><span>數量</span><div class="qty-control"><button data-detail-qty="-1" ${state.detailQty <= 1 ? 'disabled' : ''}>−</button><strong>${state.detailQty}</strong><button data-detail-qty="1" ${state.detailQty >= selected.stock || closed ? 'disabled' : ''}>＋</button></div></div><div class="detail-total"><span>小計</span><strong>${money(Number(selected.price) * state.detailQty)}</strong></div></div><button class="btn btn-primary add-cart-wide" data-action="add-selected-item" ${selected.stock <= 0 || closed ? 'disabled' : ''}>${closed ? '賣場已截止收單' : selected.stock <= 0 ? '無庫存' : '加入購物車'}</button>` : `<div class="empty">這個賣場還沒有品項</div>`}</div></div></div>`;
}

function cartModal() {
  return `<div class="modal-backdrop"><div class="modal cart-modal"><div class="modal-head"><div><span class="eyebrow">YOUR CART</span><h2>購物車</h2></div><button class="close" data-action="close">×</button></div>${state.cart.length ? `${state.cart.map((item) => `<div class="cart-line"><div><small>${esc(item.market_name || '零售區')}</small><strong>${esc(item.name)}</strong><div class="cart-subtotal">${money(Number(item.price) * item.qty)}</div></div><div class="cart-controls"><button data-cart-change="${item.id}" data-delta="-1">−</button><strong>${item.qty}</strong><button data-cart-change="${item.id}" data-delta="1" ${item.qty >= item.stock ? 'disabled' : ''}>＋</button><button class="remove-link" data-remove="${item.id}">移除</button></div></div>`).join('')}<div class="cart-total"><strong>商品合計</strong><strong>${money(cartTotal())}</strong></div><p class="cart-note">最終付款與取貨資訊由店主確認。</p><button class="btn btn-primary add-cart-wide" data-action="begin-checkout">前往結帳</button>` : `<div class="empty">購物車還是空的</div>`}</div></div>`;
}

function authModal() {
  const register = state.authMode === 'register';
  return `<div class="modal-backdrop"><div class="modal"><div class="modal-head"><div><span class="eyebrow">MEMBER</span><h2>${register ? '使用 Email 註冊' : '會員登入'}</h2></div><button class="close" data-action="close">×</button></div><div class="auth-tabs"><button class="${!register ? 'active' : ''}" data-auth-mode="login">登入</button><button class="${register ? 'active' : ''}" data-auth-mode="register">註冊</button></div><div class="field"><label>Email</label><input id="email" type="email" autocomplete="email" placeholder="you@example.com" /></div><div class="field"><label>密碼</label><input id="password" type="password" autocomplete="${register ? 'new-password' : 'current-password'}" placeholder="至少 6 個字元" /></div><button class="btn btn-primary add-cart-wide" data-action="${register ? 'signup' : 'login'}" ${state.busy ? 'disabled' : ''}>${state.busy ? '處理中…' : register ? '建立帳號' : '登入'}</button>${register ? '' : `<button class="forgot-link" data-action="forgot-password">忘記密碼？</button>`}</div></div>`;
}

function forgotPasswordModal() { return `<div class="modal-backdrop"><div class="modal"><div class="modal-head"><div><span class="eyebrow">PASSWORD RESET</span><h2>重設密碼</h2></div><button class="close" data-action="close">×</button></div><p>輸入註冊 Email，我們會寄送密碼重設連結。</p><div class="field"><label>Email</label><input id="recover-email" type="email" autocomplete="email" /></div><button class="btn btn-primary add-cart-wide" data-action="send-recovery">寄送重設信</button><button class="forgot-link" data-action="back-login">返回登入</button></div></div>`; }
function newPasswordModal() { return `<div class="modal-backdrop"><div class="modal"><div class="modal-head"><div><span class="eyebrow">NEW PASSWORD</span><h2>設定新密碼</h2></div></div><div class="field"><label>新密碼</label><input id="new-password" type="password" autocomplete="new-password" /></div><div class="field"><label>再次輸入</label><input id="confirm-password" type="password" autocomplete="new-password" /></div><button class="btn btn-primary add-cart-wide" data-action="update-password">更新密碼</button></div></div>`; }
function checkoutModal() {
  const draft = state.checkoutDraft || {}; const regulars = state.customers.filter((customer) => customer.is_regular);
  const adminModes = isManager() ? `<div class="auth-tabs"><button class="${state.checkoutMode === 'general' ? 'active' : ''}" data-checkout-mode="general">一般模式</button><button class="${state.checkoutMode === 'regular' ? 'active' : ''}" data-checkout-mode="regular">常客代下單</button></div>${state.checkoutMode === 'regular' ? `<div class="field"><label>選擇常客</label><select id="regular-customer"><option value="">請選擇</option>${regulars.map((customer) => `<option value="${customer.id}" ${draft.customerId === customer.id ? 'selected' : ''}>${esc(customer.recipient_name)}・${esc(customer.phone)}${customer.is_vip ? '・VIP' : ''}</option>`).join('')}</select></div>` : ''}` : '';
  return `<div class="modal-backdrop"><div class="modal"><div class="modal-head"><div><span class="eyebrow">CHECKOUT</span><h2>確認訂單</h2></div><button class="close" data-action="close">×</button></div>${adminModes}<div class="field"><label>收件人</label><input id="customer" autocomplete="name" value="${esc(draft.recipient || '')}" /></div><div class="field"><label>聯絡電話</label><input id="phone" autocomplete="tel" value="${esc(draft.phone || '')}" /></div><div class="field"><label>取貨方式</label><select id="delivery">${deliverySelect(draft.delivery || '面交取貨')}</select></div><div class="field"><label>訂單備註</label><input id="note" value="${esc(draft.note || '')}" placeholder="顏色、尺寸或其他需求（選填）" /></div><p class="draft-hint">輸入內容會自動保存在這台裝置，切換分頁也不會消失。</p><button class="btn btn-primary add-cart-wide" data-action="checkout" ${state.busy ? 'disabled' : ''}>${state.busy ? '送出中…' : `${state.checkoutMode === 'regular' ? '代客送出訂單' : '送出訂單'} ・ ${money(cartTotal())}`}</button></div></div>`;
}

function customerEditorModal() {
  const draft = state.customerDraft || { recipient_name: '', phone: '', delivery_method: '面交取貨', email: '', is_regular: true, is_vip: false, admin_note: '' };
  return `<div class="modal-backdrop"><div class="modal"><div class="modal-head"><div><span class="eyebrow">REGULAR CUSTOMER</span><h2>新增常客</h2></div><button class="close" data-action="close">×</button></div><div class="field"><label>收件人</label><input id="new-customer-name" value="${esc(draft.recipient_name)}"/></div><div class="field"><label>聯絡電話</label><input id="new-customer-phone" value="${esc(draft.phone)}"/></div><div class="field"><label>Email（選填）</label><input id="new-customer-email" type="email" value="${esc(draft.email)}"/></div><div class="field"><label>取貨方式</label><select id="new-customer-delivery">${deliverySelect(draft.delivery_method)}</select></div><div class="field"><label>管理員備註</label><input id="new-customer-note" value="${esc(draft.admin_note)}" placeholder="例：偏好、需留意事項"/></div><div class="tag-options"><label class="check-field"><input id="new-customer-regular" type="checkbox" checked/><span>加入常客清單</span></label><label class="check-field"><input id="new-customer-vip" type="checkbox"/><span>VIP 客戶</span></label></div><button class="btn btn-primary add-cart-wide" data-action="create-customer">建立常客</button></div></div>`;
}
function successModal() { const order = state.lastOrder; return `<div class="modal-backdrop"><div class="modal success-modal"><div class="success-mark">✓</div><span class="eyebrow">ORDER RECEIVED</span><h2>訂單已成功送出</h2><p>我們會盡快確認採購內容。</p><div class="success-order"><span>訂單編號</span><strong>${esc(order?.order_number || '處理中')}</strong><span>商品金額</span><strong>${money(order?.total_amount || 0)}</strong></div><button class="btn btn-primary add-cart-wide" data-action="view-orders">查看我的訂單</button><button class="forgot-link" data-action="continue-shopping">繼續逛逛</button></div></div>`; }

function createMarketDraft(market) {
  const defaultClose = new Date(); defaultClose.setMonth(defaultClose.getMonth() + 1);
  return {
    name: market?.name || '', description: market?.description || '', image_url: market?.image_url || '', file: null, removeBg: false,
    closes_at: dateValue(market?.closes_at) || dateValue(defaultClose),
    is_active: market?.is_active ?? true, sort_order: market?.sort_order || 0,
    products: (market?.products || []).map((item) => ({ ...item, key: item.id, file: null, removeBg: false })),
  };
}

function marketEditorModal() {
  const draft = state.marketDraft || createMarketDraft();
  const rows = draft.products.map((item, index) => `<div class="item-editor" data-item-row data-key="${esc(item.key)}" data-id="${esc(item.id || '')}"><div class="item-editor-head"><strong>品項 ${index + 1}</strong>${item.id ? `<label class="mini-switch"><input data-item-active type="checkbox" ${item.is_active !== false ? 'checked' : ''}/><span>上架</span></label>` : `<button class="remove-link" data-remove-draft-item="${esc(item.key)}">移除</button>`}</div><div class="field"><label>品項名稱</label><input data-item-name value="${esc(item.name || '')}" placeholder="例：粉色／M 號" /></div><div class="form-grid"><div class="field"><label>金額（NT$）</label><input data-item-price type="number" min="0" value="${item.price ?? ''}" /></div><div class="field"><label>數量</label><input data-item-stock type="number" min="0" step="1" value="${item.stock ?? 0}" /></div></div><div class="upload-row"><span class="upload-thumb">${item.file ? `<img src="${URL.createObjectURL(item.file)}" alt="預覽"/>` : item.image_url ? `<img src="${esc(item.image_url)}" alt="預覽"/>` : 'IMG'}</span><div class="field"><label>品項圖片（選填）</label><input data-item-image type="file" accept="image/jpeg,image/png,image/webp,image/gif"/><label class="inline-check"><input data-item-remove-bg type="checkbox" ${item.removeBg ? 'checked' : ''}/> 自動去除淺色背景</label></div></div></div>`).join('');
  return `<div class="modal-backdrop"><div class="modal market-editor"><div class="modal-head"><div><span class="eyebrow">MARKET EDITOR</span><h2>${state.editingMarketId ? '編輯賣場' : '建立賣場'}</h2></div><button class="close" data-action="close">×</button></div><div class="field"><label>賣場／商品類別名稱</label><input id="market-name" value="${esc(draft.name)}" placeholder="例：三麗鷗聯名預購" /></div><div class="field"><label>賣場說明</label><textarea id="market-description" rows="3">${esc(draft.description)}</textarea></div><div class="form-grid"><div class="field"><label>收單截止日期</label><input id="market-closes-at" type="date" value="${esc(draft.closes_at)}"/></div><label class="check-field"><input id="market-active" type="checkbox" ${draft.is_active ? 'checked' : ''}/><span>儲存後立即上架</span></label></div><div class="upload-row"><span class="upload-thumb market-upload-thumb">${draft.file ? `<img src="${URL.createObjectURL(draft.file)}" alt="封面預覽"/>` : draft.image_url ? `<img src="${esc(draft.image_url)}" alt="封面預覽"/>` : 'COVER'}</span><div class="field"><label>賣場封面（選填）</label><input id="market-image" type="file" accept="image/jpeg,image/png,image/webp,image/gif"/><label class="inline-check"><input id="market-remove-bg" type="checkbox" ${draft.removeBg ? 'checked' : ''}/> 自動去除淺色背景（適合白底商品照）</label></div></div><div class="editor-divider"><div><strong>賣場品項</strong><small>每個品項分別設定金額與數量</small></div><button class="btn btn-light" data-action="add-draft-item">＋ 新增品項</button></div><div class="item-editors">${rows || `<div class="empty">請先新增至少一個品項</div>`}</div><button class="btn btn-primary add-cart-wide" data-action="save-market" ${state.busy ? 'disabled' : ''}>${state.busy ? '儲存中…' : '儲存賣場與品項'}</button></div></div>`;
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

function render() {
  const content = state.view === 'shop' ? shop() : state.view === 'orders' ? ordersView() : adminView();
  document.querySelector('#app').innerHTML = `<div class="shell">${nav()}${content}${footer()}</div>${state.modal ? modal() : ''}${state.toast ? `<div class="toast">${esc(state.toast)}</div>` : ''}`;
  bind();
}

function openMarket(id) {
  const market = state.markets.find((item) => item.id === id);
  if (!market) return;
  const first = market.products.find((item) => item.is_active && item.stock > 0) || market.products.find((item) => item.is_active);
  state.selectedMarketId = id; state.selectedProductId = first?.id || null; state.detailQty = 1; state.modal = 'market-detail'; render();
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
  saveCart(); state.modal = 'cart'; renderToast(`${product.name} 已加入購物車`);
}

function changeCartQuantity(id, delta) {
  const item = state.cart.find((entry) => entry.id === id); if (!item) return;
  const next = item.qty + delta;
  if (next < 1) state.cart = state.cart.filter((entry) => entry.id !== id);
  else if (next <= item.stock) item.qty = next;
  else { renderToast('已達目前可購買庫存'); return; }
  saveCart(); render();
}

async function signup() {
  const email = document.querySelector('#email')?.value.trim(); const password = document.querySelector('#password')?.value || '';
  if (!email || password.length < 6) { renderToast('請填寫 Email 及至少 6 個字元的密碼'); return; }
  state.busy = true; render();
  const { data, error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: `${window.location.origin}${window.location.pathname}` } });
  state.busy = false; if (error) { renderToast(friendlyError(error)); return; }
  state.modal = null; renderToast(data.session ? '註冊成功，已登入會員' : '註冊成功，請到信箱點擊驗證連結');
}

async function login() {
  const email = document.querySelector('#email')?.value.trim(); const password = document.querySelector('#password')?.value || '';
  if (!email || !password) { renderToast('請填寫信箱與密碼'); return; }
  state.busy = true; render(); const { error } = await supabase.auth.signInWithPassword({ email, password }); state.busy = false;
  if (error) { renderToast(friendlyError(error)); return; }
  state.modal = null; state.view = 'orders'; renderToast('登入成功');
}

async function sendRecovery() {
  const email = document.querySelector('#recover-email')?.value.trim(); if (!email) return;
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}${window.location.pathname}` });
  if (error) { renderToast(friendlyError(error)); return; } state.modal = null; renderToast('重設信已寄出，請檢查 Email');
}

async function updatePassword() {
  const password = document.querySelector('#new-password')?.value || ''; const confirmation = document.querySelector('#confirm-password')?.value || '';
  if (password.length < 6 || password !== confirmation) { renderToast('請確認兩次輸入的密碼相同，且至少 6 個字元'); return; }
  const { error } = await supabase.auth.updateUser({ password }); if (error) { renderToast(friendlyError(error)); return; }
  state.modal = null; state.view = 'orders'; renderToast('密碼更新成功');
}

async function checkout() {
  const recipient = document.querySelector('#customer')?.value.trim(); const phone = document.querySelector('#phone')?.value.trim();
  const delivery = document.querySelector('#delivery')?.value; const note = document.querySelector('#note')?.value.trim() || '';
  if (!recipient || !phone) { renderToast('請填寫收件人與電話'); return; }
  if (state.checkoutMode === 'regular' && !state.checkoutDraft.customerId) { renderToast('請先選擇常客'); return; }
  state.busy = true; render();
  const items = state.cart.map((item) => ({ product_id: item.product_id, quantity: item.qty }));
  const request = isManager()
    ? supabase.rpc('admin_place_order', { p_customer_id: state.checkoutMode === 'regular' ? state.checkoutDraft.customerId : null, p_recipient_name: recipient, p_phone: phone, p_delivery_method: delivery, p_note: note, p_items: items })
    : supabase.rpc('place_order', { p_recipient_name: recipient, p_phone: phone, p_delivery_method: delivery, p_note: note, p_items: items });
  const { data: orderId, error } = await request;
  state.busy = false; if (error) { renderToast(friendlyError(error)); return; }
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
    products: [...document.querySelectorAll('[data-item-row]')].map((row) => {
      const key = row.dataset.key; const old = previous.get(key) || {};
      return { ...old, key, id: row.dataset.id || null, name: row.querySelector('[data-item-name]')?.value.trim() || '', price: row.querySelector('[data-item-price]')?.value || '', stock: row.querySelector('[data-item-stock]')?.value || '0', is_active: row.querySelector('[data-item-active]')?.checked ?? true, file: row.querySelector('[data-item-image]')?.files?.[0] || old.file || null, removeBg: Boolean(row.querySelector('[data-item-remove-bg]')?.checked) };
    }),
  };
}

function openMarketEditor(id = null) {
  if (!state.marketFeatureReady) { renderToast('請先執行賣場升級 SQL'); return; }
  const market = state.markets.find((item) => item.id === id); state.editingMarketId = id; state.marketDraft = createMarketDraft(market); state.modal = 'market-editor'; render();
}

async function saveMarket() {
  if (!isManager()) return;
  syncMarketDraftFromForm();
  const draft = state.marketDraft; const items = draft.products; const marketImage = draft.file;
  if (!draft.name || !draft.closes_at || !items.length) { renderToast('請填寫賣場名稱、截止日期，並建立至少一個品項'); return; }
  if (items.some((item) => !item.name || !Number.isFinite(Number(item.price)) || Number(item.price) < 0 || !Number.isInteger(Number(item.stock)) || Number(item.stock) < 0)) { renderToast('請正確填寫每個品項的名稱、金額與數量'); return; }
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
      if (imageUrl) payload.image_url = imageUrl; else if (!item.id) payload.image_url = null;
      const result = item.id ? await supabase.from('products').update(payload).eq('id', item.id) : await supabase.from('products').insert(payload);
      if (result.error) throw result.error;
    }
    await loadMarkets(); state.modal = null; state.marketDraft = null; state.editingMarketId = null; renderToast(existing ? '賣場與品項已更新' : '賣場已建立');
  } catch (error) { renderToast(friendlyError(error)); }
  finally { state.busy = false; render(); }
}

async function toggleMarket(id) {
  const market = state.markets.find((item) => item.id === id); if (!market) return;
  const { error } = await supabase.from('markets').update({ is_active: !market.is_active }).eq('id', id);
  if (error) { renderToast(friendlyError(error)); return; } await loadMarkets(); renderToast(market.is_active ? '賣場已下架' : '賣場已上架');
}

async function updateOrderStatus(id, status) {
  if (!isManager() || !statusLabels[status]) return;
  const { error } = await supabase.from('orders').update({ status }).eq('id', id); if (error) { renderToast(friendlyError(error)); return; }
  await loadOrders(); renderToast('訂單狀態已更新');
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
  if (!payload.recipient_name || !payload.phone) { renderToast('請填寫常客姓名與電話'); return; }
  const { error } = await supabase.from('customers').insert(payload); if (error) { renderToast(friendlyError(error)); return; }
  await loadCustomers(); state.modal = null; renderToast('常客已建立');
}

async function saveCustomer(id) {
  const row = document.querySelector(`[data-customer-row="${id}"]`); if (!row) return;
  const payload = { recipient_name: row.querySelector('[data-customer-name]').value.trim(), phone: row.querySelector('[data-customer-phone]').value.trim(), delivery_method: row.querySelector('[data-customer-delivery]').value, is_regular: row.querySelector('[data-customer-regular]').checked, is_vip: row.querySelector('[data-customer-vip]').checked, admin_note: row.querySelector('[data-customer-note]').value.trim() };
  if (!payload.recipient_name || !payload.phone) { renderToast('收件人與電話不能留白'); return; }
  const { error } = await supabase.from('customers').update(payload).eq('id', id); if (error) { renderToast(friendlyError(error)); return; }
  await loadCustomers(); renderToast('客戶資料已更新');
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
    const orderRows = state.orders.flatMap((order) => (order.order_items || []).map((item) => ({
      訂單編號: order.order_number, 日期: new Date(order.created_at).toLocaleString('zh-TW'), 收件人: order.recipient_name,
      電話: order.phone, 取貨方式: order.delivery_method, 商品品項: item.product_name, 數量: Number(item.quantity),
      單價: Number(item.unit_price), 小計: Number(item.subtotal), 訂單總額: Number(order.total_amount), 狀態: statusLabels[order.status] || order.status, 備註: order.note || '',
    })));
    const ordersSheet = XLSX.utils.json_to_sheet(orderRows.length ? orderRows : [{ 提示: '目前沒有訂單' }]); ordersSheet['!cols'] = [{ wch: 18 }, { wch: 20 }, { wch: 14 }, { wch: 16 }, { wch: 20 }, { wch: 28 }, { wch: 8 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 12 }, { wch: 24 }];
    XLSX.utils.book_append_sheet(workbook, ordersSheet, '訂單');
    for (const { market, rows } of marketSummaries(true)) {
      const data = rows.map((row) => ({ 商品品項: row.product.name, 訂購總數量: row.quantity, 購買人數: row.buyers, 目前後台庫存: Number(row.product.stock) }));
      const sheet = XLSX.utils.json_to_sheet(data); sheet['!cols'] = [{ wch: 32 }, { wch: 14 }, { wch: 12 }, { wch: 16 }];
      XLSX.utils.book_append_sheet(workbook, sheet, safeSheetName(market.name, usedNames));
    }
    XLSX.writeFile(workbook, `NewShop訂單-${new Date().toLocaleDateString('en-CA')}.xlsx`);
  } catch (error) { renderToast(`Excel 產生失敗：${friendlyError(error)}`); }
}

function bind() {
  document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', async () => { state.view = button.dataset.view; if ((state.view === 'orders' || state.view === 'admin') && state.user) await Promise.all([loadOrders(), loadMarkets(), loadCustomers()]); render(); }));
  document.querySelectorAll('[data-scroll]').forEach((button) => button.addEventListener('click', () => { const target = button.dataset.scroll; if (state.view !== 'shop') { state.view = 'shop'; render(); requestAnimationFrame(() => document.querySelector(`#${target}`)?.scrollIntoView({ behavior: 'smooth' })); } else document.querySelector(`#${target}`)?.scrollIntoView({ behavior: 'smooth' }); }));
  document.querySelectorAll('[data-open-market]').forEach((button) => button.addEventListener('click', () => openMarket(button.dataset.openMarket)));
  document.querySelectorAll('[data-select-item]').forEach((button) => button.addEventListener('click', () => { state.selectedProductId = button.dataset.selectItem; state.detailQty = 1; render(); }));
  document.querySelectorAll('[data-detail-qty]').forEach((button) => button.addEventListener('click', () => { state.detailQty += Number(button.dataset.detailQty); render(); }));
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
  document.querySelector('[data-action="logout"]')?.addEventListener('click', async () => { await supabase.auth.signOut(); state.view = 'shop'; renderToast('已登出'); });
  document.querySelector('[data-action="begin-checkout"]')?.addEventListener('click', () => { if (!state.user) { state.authMode = 'login'; state.modal = 'auth'; renderToast('請先登入，再送出訂單'); return; } state.modal = 'checkout'; render(); });
  document.querySelector('[data-action="checkout"]')?.addEventListener('click', checkout);
  document.querySelectorAll('#customer,#phone,#delivery,#note').forEach((input) => input.addEventListener('input', persistCheckoutDraft));
  document.querySelectorAll('[data-checkout-mode]').forEach((button) => button.addEventListener('click', () => { persistCheckoutDraft(); state.checkoutMode = button.dataset.checkoutMode; if (state.checkoutMode === 'general') state.checkoutDraft.customerId = null; saveCheckoutDraft(); render(); }));
  document.querySelector('#regular-customer')?.addEventListener('change', (event) => selectRegularCustomer(event.target.value));
  document.querySelector('[data-action="view-orders"]')?.addEventListener('click', () => { state.modal = null; state.view = 'orders'; render(); });
  document.querySelector('[data-action="continue-shopping"]')?.addEventListener('click', () => { state.modal = null; state.view = 'shop'; render(); });
  document.querySelector('[data-action="export"]')?.addEventListener('click', exportExcel);
  document.querySelector('[data-action="new-customer"]')?.addEventListener('click', () => { state.customerDraft = null; state.modal = 'customer-editor'; render(); });
  document.querySelector('[data-action="create-customer"]')?.addEventListener('click', createCustomer);
  document.querySelectorAll('[data-save-customer]').forEach((button) => button.addEventListener('click', () => saveCustomer(button.dataset.saveCustomer)));
  document.querySelector('[data-action="new-market"]')?.addEventListener('click', () => openMarketEditor());
  document.querySelectorAll('[data-edit-market]').forEach((button) => button.addEventListener('click', () => openMarketEditor(button.dataset.editMarket)));
  document.querySelectorAll('[data-toggle-market]').forEach((button) => button.addEventListener('click', () => toggleMarket(button.dataset.toggleMarket)));
  document.querySelector('[data-action="add-draft-item"]')?.addEventListener('click', () => { syncMarketDraftFromForm(); state.marketDraft.products.push({ key: crypto.randomUUID(), name: '', price: '', stock: 0, is_active: true, file: null, removeBg: false }); render(); });
  document.querySelectorAll('[data-remove-draft-item]').forEach((button) => button.addEventListener('click', () => { syncMarketDraftFromForm(); state.marketDraft.products = state.marketDraft.products.filter((item) => item.key !== button.dataset.removeDraftItem); render(); }));
  document.querySelector('#market-image')?.addEventListener('change', () => { syncMarketDraftFromForm(); render(); });
  document.querySelectorAll('[data-item-image]').forEach((input) => input.addEventListener('change', () => { syncMarketDraftFromForm(); render(); }));
  document.querySelector('[data-action="save-market"]')?.addEventListener('click', saveMarket);
  document.querySelectorAll('[data-order-status]').forEach((select) => select.addEventListener('change', () => updateOrderStatus(select.dataset.orderStatus, select.value)));
}

render();
initialize();
