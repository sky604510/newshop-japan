import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabase = createClient(
  'https://qikmnuchhfmkseoenawr.supabase.co',
  'sb_publishable_EGSzGcTPs8krwlf7H7TsMA_mVc7wk83',
  { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } },
);

const statusLabels = { pending: '待確認', confirmed: '已確認', preparing: '備貨中', shipped: '已出貨', completed: '已完成', cancelled: '已取消' };
const managerRoles = new Set(['admin', 'owner']);
const state = {
  view: 'shop', cart: JSON.parse(localStorage.getItem('newshop_cart') || '[]'),
  user: null, profile: null, markets: [], products: [], orders: [], modal: null,
  selectedMarketId: null, selectedProductId: null, detailQty: 1,
  marketDraft: null, editingMarketId: null, lastOrder: null,
  authMode: 'login', loading: true, busy: false, toast: '', marketFeatureReady: true,
};

const money = (value) => `NT$ ${Number(value || 0).toLocaleString('zh-TW')}`;
const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
const saveCart = () => localStorage.setItem('newshop_cart', JSON.stringify(state.cart));
const cartCount = () => state.cart.reduce((sum, item) => sum + item.qty, 0);
const cartTotal = () => state.cart.reduce((sum, item) => sum + Number(item.price) * item.qty, 0);
const isManager = () => managerRoles.has(state.profile?.role);

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
  const marketQuery = await supabase.from('markets')
    .select('id,slug,name,description,image_url,is_active,sort_order,created_at,products(id,market_id,name,description,price,image_url,stock,is_active,created_at)')
    .order('sort_order').order('created_at');

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
  const { data, error } = await supabase.from('orders')
    .select('id,order_number,user_id,recipient_name,phone,delivery_method,note,status,total_amount,created_at,order_items(id,product_name,unit_price,quantity,subtotal)')
    .order('created_at', { ascending: false });
  if (error) throw error;
  state.orders = data || [];
}

async function syncSession(session) {
  state.user = session?.user || null;
  if (!state.user) {
    state.profile = null; state.orders = [];
    if (state.view === 'admin') state.view = 'shop';
    await loadMarkets(); render(); return;
  }
  try { await Promise.all([loadProfile(), loadOrders(), loadMarkets()]); }
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
  const admin = isManager() ? `<button class="${state.view === 'admin' ? 'active' : ''}" data-view="admin">${state.profile?.role === 'owner' ? '所有者後台' : '店主後台'}</button>` : '';
  const member = state.user ? esc(state.user.email || '會員') : '登入';
  return `<header class="nav"><button class="brand" data-view="shop"><img class="brand-logo" src="./assets/newshop-logo.png" alt="NewShop Logo"/><span>NewShop日本連線代購<small>JAPAN SELECT SHOP</small></span></button><nav class="navlinks"><button class="${state.view === 'shop' ? 'active' : ''}" data-view="shop">逛賣場</button><button data-scroll="guide">購物須知</button><button class="${state.view === 'orders' ? 'active' : ''}" data-view="orders">${member}</button>${admin}<button class="cart-btn" data-action="cart">購物車 <span class="badge">${cartCount()}</span></button></nav></header>`;
}

function marketPrice(market) {
  const items = market.products.filter((item) => item.is_active);
  const prices = items.map((item) => Number(item.price));
  if (!prices.length) return '暂無品項';
  const min = Math.min(...prices); const max = Math.max(...prices);
  return min === max ? money(min) : `${money(min)} 起`;
}

function marketCard(market, index) {
  const items = market.products.filter((item) => item.is_active);
  const cover = market.image_url || items.find((item) => item.image_url)?.image_url;
  const art = cover ? `<img src="${esc(cover)}" alt="${esc(market.name)}" />` : `<span class="market-emoji">${market.emoji}</span>`;
  const soldOut = !items.some((item) => Number(item.stock) > 0);
  return `<article class="market-card reveal" style="--delay:${Math.min(index * 70, 280)}ms"><button class="market-cover" data-open-market="${market.id}" aria-label="查看 ${esc(market.name)}">${art}<span class="market-pill">DROP ${String(index + 1).padStart(2, '0')}</span><span class="market-arrow">↗</span></button><div class="market-copy"><div class="market-meta"><span>${items.length} ITEMS</span><span>${soldOut ? 'SOLD OUT' : 'AVAILABLE NOW'}</span></div><h3>${esc(market.name)}</h3><p>${esc(market.description || '精選日本限定商品。')}</p><div class="market-bottom"><strong>${marketPrice(market)}</strong><button class="text-link" data-open-market="${market.id}" ${soldOut ? 'disabled' : ''}>${soldOut ? '全數售完' : '進入賣場 →'}</button></div></div></article>`;
}

function shop() {
  const markets = state.markets.filter((market) => market.is_active);
  const cards = state.loading ? `<div class="empty">正在同步日本連線賣場…</div>` : markets.length ? markets.map(marketCard).join('') : `<div class="empty">目前沒有上架賣場</div>`;
  const featured = markets.flatMap((market) => market.products.map((item) => ({ ...item, market }))).find((item) => item.image_url) || null;
  const heroMedia = featured ? `<img src="${esc(featured.image_url)}" alt="${esc(featured.name)}"/><div class="hero-image-caption"><span>${esc(featured.market.name)}</span><strong>${esc(featured.name)}</strong></div>` : `<div class="hero-type-art"><span>NEW</span><strong>SHOP</strong><small>JAPAN CONNECTION</small></div>`;
  return `<main><div class="drop-bar"><span>NEW DROP</span><span>JAPAN DIRECT</span><span>LIMITED PICKS</span><span>NEW DROP</span><span>JAPAN DIRECT</span></div><section class="hero"><div class="hero-copy reveal"><div class="hero-kicker"><span>01 / TOKYO EDIT</span><span>2026 AUTUMN</span></div><h1>把喜歡的，<br/><em>從日本帶回日常。</em></h1><div class="hero-bottom"><p>限量連線選物。每個賣場收納不同品項、價格與庫存，選好就能直接下單。</p><button class="round-cta" data-scroll="markets"><span>SHOP<br/>NOW</span><b>↘</b></button></div></div><div class="hero-visual reveal" style="--delay:100ms">${heroMedia}<span class="vertical-type">NEW SHOP ・ JAPAN CONNECTION</span><span class="edition-stamp">NS<br/>26</span></div></section><div class="ticker" aria-hidden="true"><div><span>✦ TOKYO SELECT</span><span>✦ OSAKA FINDS</span><span>✦ LIMITED PRE-ORDER</span><span>✦ PICKED WITH LOVE</span><span>✦ TOKYO SELECT</span><span>✦ OSAKA FINDS</span></div></div><section id="markets"><div class="catalog-head"><span class="catalog-number">02</span><div><span class="eyebrow">CURATED MARKETS</span><h2>這期，想帶回什麼？</h2></div><p>點進賣場，選擇品項與數量。<br/>每款價格與庫存獨立計算。</p></div><div class="markets-grid">${cards}</div></section><section id="guide" class="guide"><div class="guide-title"><span>03</span><h2>HOW TO<br/><i>ORDER</i></h2></div><div class="guide-grid"><article><span>01</span><h3>進入賣場</h3><p>打開感興趣的賣場，查看全部品項。</p></article><article><span>02</span><h3>選品項與數量</h3><p>各品項有獨立價格與庫存，選好後加入購物車。</p></article><article><span>03</span><h3>登入送單</h3><p>送出後可查詢進度，店主會再確認採購內容。</p></article></div><div class="notice"><div><span class="eyebrow">BEFORE YOU BUY</span><h3>連線購買須知</h3><p>價格、庫存與到貨時間以店主最後確認為準，特殊需求請寫在訂單備註。</p></div><a class="round-mail" href="mailto:sky604510@gmail.com">↗</a></div></section></main>`;
}

function orderRow(order) {
  const items = order.order_items || [];
  return `<div class="order"><div><strong>${esc(order.order_number)}</strong><div class="order-items">${items.map((item) => `${esc(item.product_name)} × ${item.quantity}`).join('、')}</div><small>${new Date(order.created_at).toLocaleString('zh-TW')}</small></div><div class="order-price"><strong>${money(order.total_amount)}</strong><div class="status">${statusLabels[order.status] || esc(order.status)}</div></div></div>`;
}

function ordersView() {
  if (!state.user) return `<main class="split"><section class="panel"><span class="eyebrow">MEMBER AREA</span><h2>登入後查看訂單</h2><p>使用信箱建立帳號，就能跨裝置查詢訂購進度。</p><button class="btn btn-primary" data-modal="auth">登入／註冊</button></section><section class="panel"><h2>訂單紀錄</h2><div class="empty">登入後顯示你的訂單</div></section></main>`;
  return `<main class="split"><section class="panel member-card"><span class="eyebrow">MEMBER AREA</span><h2>我的訂單</h2><p>${esc(state.user.email)}</p><button class="btn btn-primary" data-action="logout">登出</button></section><section class="panel"><h2>訂單紀錄</h2>${state.orders.length ? state.orders.map(orderRow).join('') : `<div class="empty">目前還沒有訂單<br/><button class="btn btn-accent" data-view="shop">去逛逛</button></div>`}</section></main>`;
}

function adminView() {
  if (!isManager()) return `<main class="panel admin-page"><div class="empty">這個頁面只開放店主管理員</div></main>`;
  const total = state.orders.filter((order) => order.status !== 'cancelled').reduce((sum, order) => sum + Number(order.total_amount), 0);
  const statusOptions = (current) => Object.entries(statusLabels).map(([value, label]) => `<option value="${value}" ${current === value ? 'selected' : ''}>${label}</option>`).join('');
  const orderRows = state.orders.map((order) => `<tr><td>${esc(order.order_number)}</td><td>${esc(order.recipient_name)}<br/><small>${esc(order.phone)}</small></td><td>${(order.order_items || []).map((item) => `${esc(item.product_name)} × ${item.quantity}`).join('<br/>')}</td><td>${money(order.total_amount)}</td><td><select data-order-status="${order.id}">${statusOptions(order.status)}</select></td></tr>`).join('');
  const marketRows = state.markets.map((market) => `<tr><td><strong>${esc(market.name)}</strong><br/><small>${market.is_active ? '已上架' : '已下架'}</small></td><td>${market.products.length}</td><td>${market.products.reduce((sum, item) => sum + Number(item.stock), 0)}</td><td><div class="admin-actions"><button class="btn btn-light" data-edit-market="${market.id}">編輯賣場</button><button class="btn ${market.is_active ? 'btn-danger-soft' : 'btn-accent'}" data-toggle-market="${market.id}">${market.is_active ? '下架' : '上架'}</button></div></td></tr>`).join('');
  const migrationNotice = state.marketFeatureReady ? '' : `<div class="setup-notice">請先在 Supabase 執行 <strong>market_items_upgrade.sql</strong>，才能建立多品項賣場。</div>`;
  return `<main class="admin-page"><section class="panel"><div class="section-head"><div><span class="eyebrow">OWNER CONSOLE</span><h2>訂單總覽</h2><p>${esc(state.user?.email)} ・ ${state.profile?.role === 'owner' ? '最高所有者' : '管理員'}</p></div><button class="btn btn-primary" data-action="export">下載 Excel 報表</button></div><div class="admin-stats"><div class="stat"><small>總訂單</small><strong>${state.orders.length}</strong></div><div class="stat"><small>待處理</small><strong>${state.orders.filter((order) => order.status === 'pending').length}</strong></div><div class="stat"><small>有效訂單總額</small><strong>${money(total)}</strong></div></div>${state.orders.length ? `<div class="table-wrap"><table class="admin-table"><thead><tr><th>訂單編號</th><th>收件人</th><th>品項</th><th>金額</th><th>狀態</th></tr></thead><tbody>${orderRows}</tbody></table></div>` : `<div class="empty">還沒有訂單</div>`}</section><section class="panel">${migrationNotice}<div class="section-head"><div><span class="eyebrow">MARKETS & ITEMS</span><h2>賣場管理</h2><p>一個賣場可以包含多個品項，每個品項有獨立金額與數量。</p></div><button class="btn btn-accent" data-action="new-market" ${state.marketFeatureReady ? '' : 'disabled'}>＋ 建立賣場</button></div>${state.markets.length ? `<div class="table-wrap"><table class="admin-table"><thead><tr><th>賣場</th><th>品項數</th><th>總庫存</th><th>操作</th></tr></thead><tbody>${marketRows}</tbody></table></div>` : `<div class="empty">尚未建立賣場</div>`}</section></main>`;
}

function footer() { return `<footer><strong>NewShop日本連線代購</strong><span><a href="mailto:sky604510@gmail.com">sky604510@gmail.com</a> ・ 會員與訂單由 Supabase 安全保存</span></footer>`; }

function marketDetailModal() {
  const market = state.markets.find((item) => item.id === state.selectedMarketId);
  if (!market) return '';
  const items = market.products.filter((item) => item.is_active);
  const selected = items.find((item) => item.id === state.selectedProductId) || items.find((item) => item.stock > 0) || items[0];
  const cover = selected?.image_url || market.image_url;
  const art = cover ? `<img src="${esc(cover)}" alt="${esc(market.name)}" />` : `<span class="detail-emoji">${market.emoji}</span>`;
  return `<div class="modal-backdrop"><div class="modal market-detail"><button class="close detail-close" data-action="close">×</button><div class="detail-media">${art}<span class="market-pill">${esc(market.name)}</span></div><div class="detail-copy"><span class="eyebrow">SELECT YOUR ITEM</span><h2>${esc(market.name)}</h2><p>${esc(market.description)}</p><div class="item-label">品項 <small>每款價格與庫存不同</small></div><div class="item-options">${items.map((item) => `<button class="item-option ${selected?.id === item.id ? 'selected' : ''}" data-select-item="${item.id}" ${item.stock <= 0 ? 'disabled' : ''}><span>${esc(item.name)}</span><strong>${item.stock <= 0 ? '已售完' : money(item.price)}</strong><small>${item.stock > 0 ? `剩餘 ${item.stock} 件` : ''}</small></button>`).join('')}</div>${selected ? `<div class="detail-buy"><div><span>數量</span><div class="qty-control"><button data-detail-qty="-1" ${state.detailQty <= 1 ? 'disabled' : ''}>−</button><strong>${state.detailQty}</strong><button data-detail-qty="1" ${state.detailQty >= selected.stock ? 'disabled' : ''}>＋</button></div></div><div class="detail-total"><span>小計</span><strong>${money(Number(selected.price) * state.detailQty)}</strong></div></div><button class="btn btn-primary add-cart-wide" data-action="add-selected-item" ${selected.stock <= 0 ? 'disabled' : ''}>${selected.stock <= 0 ? '此品項已售完' : '加入購物車'}</button>` : `<div class="empty">這個賣場還沒有品項</div>`}</div></div></div>`;
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
function checkoutModal() { return `<div class="modal-backdrop"><div class="modal"><div class="modal-head"><div><span class="eyebrow">CHECKOUT</span><h2>確認訂單</h2></div><button class="close" data-action="close">×</button></div><div class="field"><label>收件人</label><input id="customer" autocomplete="name" /></div><div class="field"><label>聯絡電話</label><input id="phone" autocomplete="tel" /></div><div class="field"><label>取貨方式</label><select id="delivery"><option>面交取貨</option><option>宅配到府</option></select></div><div class="field"><label>訂單備註</label><input id="note" placeholder="顏色、尺寸或其他需求（選填）" /></div><button class="btn btn-primary add-cart-wide" data-action="checkout" ${state.busy ? 'disabled' : ''}>${state.busy ? '送出中…' : `送出訂單 ・ ${money(cartTotal())}`}</button></div></div>`; }
function successModal() { const order = state.lastOrder; return `<div class="modal-backdrop"><div class="modal success-modal"><div class="success-mark">✓</div><span class="eyebrow">ORDER RECEIVED</span><h2>訂單已成功送出</h2><p>我們會盡快確認採購內容。</p><div class="success-order"><span>訂單編號</span><strong>${esc(order?.order_number || '處理中')}</strong><span>商品金額</span><strong>${money(order?.total_amount || 0)}</strong></div><button class="btn btn-primary add-cart-wide" data-action="view-orders">查看我的訂單</button><button class="forgot-link" data-action="continue-shopping">繼續逛逛</button></div></div>`; }

function createMarketDraft(market) {
  return {
    name: market?.name || '', description: market?.description || '', image_url: market?.image_url || '', file: null,
    is_active: market?.is_active ?? true, sort_order: market?.sort_order || 0,
    products: (market?.products || []).map((item) => ({ ...item, key: item.id, file: null })),
  };
}

function marketEditorModal() {
  const draft = state.marketDraft || createMarketDraft();
  const rows = draft.products.map((item, index) => `<div class="item-editor" data-item-row data-key="${esc(item.key)}" data-id="${esc(item.id || '')}"><div class="item-editor-head"><strong>品項 ${index + 1}</strong>${item.id ? `<label class="mini-switch"><input data-item-active type="checkbox" ${item.is_active !== false ? 'checked' : ''}/><span>上架</span></label>` : `<button class="remove-link" data-remove-draft-item="${esc(item.key)}">移除</button>`}</div><div class="field"><label>品項名稱</label><input data-item-name value="${esc(item.name || '')}" placeholder="例：粉色／M 號" /></div><div class="form-grid"><div class="field"><label>金額（NT$）</label><input data-item-price type="number" min="0" value="${item.price ?? ''}" /></div><div class="field"><label>數量</label><input data-item-stock type="number" min="0" step="1" value="${item.stock ?? 0}" /></div></div><div class="field"><label>品項圖片（選填）</label><input data-item-image type="file" accept="image/jpeg,image/png,image/webp,image/gif" />${item.image_url ? `<small>已有圖片，沒有選新圖時會保留。</small>` : ''}${item.file ? `<small>已選擇：${esc(item.file.name)}</small>` : ''}</div></div>`).join('');
  return `<div class="modal-backdrop"><div class="modal market-editor"><div class="modal-head"><div><span class="eyebrow">MARKET EDITOR</span><h2>${state.editingMarketId ? '編輯賣場' : '建立賣場'}</h2></div><button class="close" data-action="close">×</button></div><div class="field"><label>賣場／商品類別名稱</label><input id="market-name" value="${esc(draft.name)}" placeholder="例：三麗鷗聯名預購" /></div><div class="field"><label>賣場說明</label><textarea id="market-description" rows="3">${esc(draft.description)}</textarea></div><div class="field"><label>賣場封面（選填）</label><input id="market-image" type="file" accept="image/jpeg,image/png,image/webp,image/gif" />${draft.image_url ? `<small>已有封面圖。</small>` : ''}${draft.file ? `<small>已選擇：${esc(draft.file.name)}</small>` : ''}</div><div class="editor-divider"><div><strong>賣場品項</strong><small>每個品項分別設定金額與數量</small></div><button class="btn btn-light" data-action="add-draft-item">＋ 新增品項</button></div><div class="item-editors">${rows || `<div class="empty">請先新增至少一個品項</div>`}</div><label class="check-field"><input id="market-active" type="checkbox" ${draft.is_active ? 'checked' : ''}/><span>儲存後立即上架賣場</span></label><button class="btn btn-primary add-cart-wide" data-action="save-market" ${state.busy ? 'disabled' : ''}>${state.busy ? '儲存中…' : '儲存賣場與品項'}</button></div></div>`;
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
  if (!product || !product.is_active || product.stock <= 0) return;
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
  state.busy = true; render();
  const { data: orderId, error } = await supabase.rpc('place_order', { p_recipient_name: recipient, p_phone: phone, p_delivery_method: delivery, p_note: note, p_items: state.cart.map((item) => ({ product_id: item.product_id, quantity: item.qty })) });
  state.busy = false; if (error) { renderToast(friendlyError(error)); return; }
  state.cart = []; saveCart(); state.view = 'orders'; await Promise.all([loadOrders(), loadMarkets()]);
  state.lastOrder = state.orders.find((order) => order.id === orderId) || state.orders[0] || null; state.modal = 'success'; render();
}

async function uploadImage(file) {
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
    is_active: Boolean(document.querySelector('#market-active')?.checked),
    file: document.querySelector('#market-image')?.files?.[0] || state.marketDraft?.file || null,
    products: [...document.querySelectorAll('[data-item-row]')].map((row) => {
      const key = row.dataset.key; const old = previous.get(key) || {};
      return { ...old, key, id: row.dataset.id || null, name: row.querySelector('[data-item-name]')?.value.trim() || '', price: row.querySelector('[data-item-price]')?.value || '', stock: row.querySelector('[data-item-stock]')?.value || '0', is_active: row.querySelector('[data-item-active]')?.checked ?? true, file: row.querySelector('[data-item-image]')?.files?.[0] || old.file || null };
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
  if (!draft.name || !items.length) { renderToast('請填寫賣場名稱，並建立至少一個品項'); return; }
  if (items.some((item) => !item.name || !Number.isFinite(Number(item.price)) || Number(item.price) < 0 || !Number.isInteger(Number(item.stock)) || Number(item.stock) < 0)) { renderToast('請正確填寫每個品項的名稱、金額與數量'); return; }
  state.busy = true; render();
  try {
    const existing = state.markets.find((item) => item.id === state.editingMarketId);
    const coverUrl = await uploadImage(marketImage);
    const marketPayload = { name: draft.name, description: draft.description, is_active: draft.is_active };
    if (coverUrl) marketPayload.image_url = coverUrl; else if (!existing) marketPayload.image_url = null;
    let marketId = existing?.id;
    if (existing) { const { error } = await supabase.from('markets').update(marketPayload).eq('id', existing.id); if (error) throw error; }
    else { const { data, error } = await supabase.from('markets').insert(marketPayload).select('id').single(); if (error) throw error; marketId = data.id; }

    for (const item of items) {
      const imageUrl = await uploadImage(item.file);
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

function exportCsv() {
  const rows = [['訂單編號', '日期', '收件人', '電話', '取貨方式', '品項', '數量', '單價', '小計', '訂單總額', '狀態'], ...state.orders.flatMap((order) => (order.order_items || []).map((item) => [order.order_number, new Date(order.created_at).toLocaleString('zh-TW'), order.recipient_name, order.phone, order.delivery_method, item.product_name, item.quantity, item.unit_price, item.subtotal, order.total_amount, statusLabels[order.status] || order.status]))];
  const csv = '\ufeff' + rows.map((row) => row.map((value) => `"${String(value ?? '').replaceAll('"', '""')}"`).join(',')).join('\n');
  const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); link.download = `NewShop訂單-${new Date().toISOString().slice(0, 10)}.csv`; link.click(); URL.revokeObjectURL(link.href);
}

function bind() {
  document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', async () => { state.view = button.dataset.view; if ((state.view === 'orders' || state.view === 'admin') && state.user) await Promise.all([loadOrders(), loadMarkets()]); render(); }));
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
  document.querySelector('[data-action="view-orders"]')?.addEventListener('click', () => { state.modal = null; state.view = 'orders'; render(); });
  document.querySelector('[data-action="continue-shopping"]')?.addEventListener('click', () => { state.modal = null; state.view = 'shop'; render(); });
  document.querySelector('[data-action="export"]')?.addEventListener('click', exportCsv);
  document.querySelector('[data-action="new-market"]')?.addEventListener('click', () => openMarketEditor());
  document.querySelectorAll('[data-edit-market]').forEach((button) => button.addEventListener('click', () => openMarketEditor(button.dataset.editMarket)));
  document.querySelectorAll('[data-toggle-market]').forEach((button) => button.addEventListener('click', () => toggleMarket(button.dataset.toggleMarket)));
  document.querySelector('[data-action="add-draft-item"]')?.addEventListener('click', () => { syncMarketDraftFromForm(); state.marketDraft.products.push({ key: crypto.randomUUID(), name: '', price: '', stock: 0, is_active: true, file: null }); render(); });
  document.querySelectorAll('[data-remove-draft-item]').forEach((button) => button.addEventListener('click', () => { syncMarketDraftFromForm(); state.marketDraft.products = state.marketDraft.products.filter((item) => item.key !== button.dataset.removeDraftItem); render(); }));
  document.querySelector('[data-action="save-market"]')?.addEventListener('click', saveMarket);
  document.querySelectorAll('[data-order-status]').forEach((select) => select.addEventListener('change', () => updateOrderStatus(select.dataset.orderStatus, select.value)));
}

render();
initialize();
