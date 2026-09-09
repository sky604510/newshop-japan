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
  user: null, profile: null, products: [], orders: [], modal: null,
  authMode: 'login', loading: true, busy: false, toast: '', editingProductId: null,
};

const money = (value) => `NT$ ${Number(value || 0).toLocaleString('zh-TW')}`;
const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
const saveCart = () => localStorage.setItem('newshop_cart', JSON.stringify(state.cart));
const cartCount = () => state.cart.reduce((sum, item) => sum + item.qty, 0);
const cartTotal = () => state.cart.reduce((sum, item) => sum + Number(item.price) * item.qty, 0);
const isManager = () => managerRoles.has(state.profile?.role);

function renderToast(message) {
  state.toast = message; render();
  window.setTimeout(() => { state.toast = ''; render(); }, 2400);
}

function friendlyError(error) {
  const message = error?.message || String(error || '發生未知錯誤');
  if (/invalid login credentials/i.test(message)) return '信箱或密碼錯誤';
  if (/user already registered/i.test(message)) return '這個信箱已經註冊';
  if (/email not confirmed/i.test(message)) return '請先到信箱完成驗證';
  if (/insufficient_stock/i.test(message)) return `商品庫存不足：${message.split(':').slice(1).join(':').trim()}`;
  if (/product_not_available/i.test(message)) return '部分商品已下架，請重新整理購物袋';
  if (/login_required/i.test(message)) return '請先登入會員';
  return message;
}

async function loadProducts() {
  const { data, error } = await supabase.from('products').select('id,name,description,price,image_url,stock,is_active,created_at').order('created_at');
  if (error) throw error;
  const icons = ['🍪', '🧴', '🛍️', '🎁', '🇯🇵'];
  state.products = (data || []).map((product, index) => ({ ...product, emoji: icons[index % icons.length] }));
  state.cart = state.cart.map((item) => {
    const latest = state.products.find((product) => product.id === item.id);
    return latest ? { ...item, name: latest.name, price: Number(latest.price), stock: latest.stock } : null;
  }).filter(Boolean);
  saveCart();
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
    render(); return;
  }
  try { await Promise.all([loadProfile(), loadOrders(), loadProducts()]); }
  catch (error) { renderToast(friendlyError(error)); }
  render();
}

async function initialize() {
  try {
    const [{ data }] = await Promise.all([supabase.auth.getSession(), loadProducts()]);
    await syncSession(data.session);
  } catch (error) {
    renderToast(`Supabase 連線失敗：${friendlyError(error)}`);
  } finally {
    state.loading = false; render();
  }
}

supabase.auth.onAuthStateChange((event, session) => window.setTimeout(() => {
  if (event === 'PASSWORD_RECOVERY') {
    state.user = session?.user || null;
    state.modal = 'new-password';
    render();
    return;
  }
  syncSession(session);
}, 0));

function nav() {
  const admin = isManager() ? `<button class="${state.view === 'admin' ? 'active' : ''}" data-view="admin">${state.profile?.role === 'owner' ? '所有者後台' : '店主後台'}</button>` : '';
  const member = state.user ? esc(state.user.email || '會員') : '登入';
  return `<header class="nav"><button class="brand" data-view="shop"><span class="mark">✦</span><span>NewShop日本連線代購<small style="display:block;color:var(--muted);font-weight:500;font-size:10px;letter-spacing:.18em">JAPAN SELECT SHOP</small></span></button><nav class="navlinks"><button class="${state.view === 'shop' ? 'active' : ''}" data-view="shop">買東西</button><button class="${state.view === 'orders' ? 'active' : ''}" data-view="orders">${member}</button>${admin}<button class="cart-btn" data-action="cart">購物袋 <span class="badge">${cartCount()}</span></button></nav></header>`;
}

function productCard(product) {
  const soldOut = Number(product.stock) <= 0;
  const art = product.image_url ? `<img src="${esc(product.image_url)}" alt="${esc(product.name)}" style="width:100%;height:100%;object-fit:cover;border-radius:14px" />` : esc(product.emoji);
  return `<article class="product"><div class="product-art"><span class="product-tag">${soldOut ? '目前售完' : `剩餘 ${product.stock} 件`}</span>${art}</div><div class="product-info"><h3>${esc(product.name)}</h3><p>${esc(product.description)}</p><div class="product-bottom"><span class="price">${money(product.price)}</span><button class="btn btn-accent" data-add="${product.id}" ${soldOut ? 'disabled' : ''}>${soldOut ? '已售完' : '加入購物袋'}</button></div></div></article>`;
}

function shop() {
  const activeProducts = state.products.filter((product) => product.is_active);
  const products = state.loading ? `<div class="empty" style="grid-column:1/-1">正在同步日本連線商品…</div>` : activeProducts.length ? activeProducts.map(productCard).join('') : `<div class="empty" style="grid-column:1/-1">目前沒有上架商品</div>`;
  return `<main><section class="hero"><div class="hero-copy"><span class="eyebrow">日本連線・少量代購</span><h1>把日本的<br/><em style="color:var(--coral)">喜歡帶回來。</em></h1><p>NewShop 精選日本限定商品。登入會員、加入購物袋並送出訂單，我們會在確認採購後通知你。</p><button class="btn btn-primary" data-scroll="products">開始選購 ↓</button></div><div class="hero-card"><span class="card-label">NEW FROM JAPAN / 01</span><div class="card-copy"><h2>日本連線選物</h2><p style="opacity:.8;line-height:1.7">限量零食、藥妝與生活雜貨，每批連線都會更新。</p><button class="btn btn-light" data-scroll="products">查看本期商品</button></div></div></section><section id="products"><div class="section-head"><div><h2>本期連線商品</h2><p>價格與庫存由店主即時更新。</p></div><span class="eyebrow">LIVE FROM SUPABASE</span></div><div class="products">${products}</div></section></main>`;
}

function orderRow(order) {
  const items = order.order_items || [];
  return `<div class="order"><div><strong>${esc(order.order_number)}</strong><div style="font-size:13px;color:var(--muted);margin-top:4px">${items.map((item) => `${esc(item.product_name)} × ${item.quantity}`).join('、')}</div><small style="color:var(--muted)">${new Date(order.created_at).toLocaleString('zh-TW')}</small></div><div style="text-align:right"><strong>${money(order.total_amount)}</strong><div class="status">${statusLabels[order.status] || esc(order.status)}</div></div></div>`;
}

function ordersView() {
  if (!state.user) return `<main class="split"><section class="panel"><span class="eyebrow">MEMBER AREA</span><h2 style="margin-top:10px">登入後查看訂單</h2><p style="color:var(--muted);line-height:1.8">使用信箱建立帳號，就能跨裝置查詢每次訂購。</p><button class="btn btn-primary" data-modal="auth">登入／註冊</button></section><section class="panel"><h2>訂單紀錄</h2><div class="empty">登入後顯示你的 SQL 訂單資料</div></section></main>`;
  return `<main class="split"><section class="panel"><span class="eyebrow">MEMBER AREA</span><h2 style="margin-top:10px">我的訂單</h2><p style="color:var(--muted)">${esc(state.user.email)}</p><button class="btn btn-primary" data-action="logout">登出</button></section><section class="panel"><h2>訂單紀錄</h2>${state.orders.length ? state.orders.map(orderRow).join('') : `<div class="empty">目前還沒有訂單<br/><button class="btn btn-accent" data-view="shop" style="margin-top:12px">去逛逛</button></div>`}</section></main>`;
}

function adminView() {
  if (!isManager()) return `<main class="panel" style="margin:30px 0 80px"><div class="empty">這個頁面只開放店主管理員</div></main>`;
  const total = state.orders.filter((order) => order.status !== 'cancelled').reduce((sum, order) => sum + Number(order.total_amount), 0);
  const statusOptions = (current) => Object.entries(statusLabels).map(([value, label]) => `<option value="${value}" ${current === value ? 'selected' : ''}>${label}</option>`).join('');
  const productRows = state.products.map((product) => `<tr><td><strong>${esc(product.name)}</strong><br/><small>${product.is_active ? '已上架' : '已下架'}</small></td><td>${money(product.price)}</td><td>${product.stock}</td><td><div class="admin-actions"><button class="btn btn-light" data-edit-product="${product.id}">編輯</button><button class="btn ${product.is_active ? 'btn-danger-soft' : 'btn-accent'}" data-toggle-product="${product.id}">${product.is_active ? '下架' : '上架'}</button></div></td></tr>`).join('');
  const orderRows = state.orders.map((order) => `<tr><td>${esc(order.order_number)}</td><td>${esc(order.recipient_name)}<br/><small>${esc(order.phone)}</small></td><td>${(order.order_items || []).map((item) => `${esc(item.product_name)} × ${item.quantity}`).join('<br/>')}</td><td>${money(order.total_amount)}</td><td><select data-order-status="${order.id}">${statusOptions(order.status)}</select></td></tr>`).join('');
  return `<main class="admin-page"><section class="panel"><div class="section-head"><div><span class="eyebrow">OWNER CONSOLE</span><h2 style="margin-top:10px">訂單總覽</h2><p>${esc(state.user?.email)}・${state.profile?.role === 'owner' ? '最高所有者' : '管理員'}</p></div><button class="btn btn-primary" data-action="export">下載 Excel 報表</button></div><div class="admin-stats"><div class="stat"><small>總訂單</small><strong>${state.orders.length}</strong></div><div class="stat"><small>待處理</small><strong>${state.orders.filter((order) => order.status === 'pending').length}</strong></div><div class="stat"><small>有效訂單總額</small><strong>${money(total)}</strong></div></div>${state.orders.length ? `<div class="table-wrap"><table class="admin-table"><thead><tr><th>訂單編號</th><th>收件人</th><th>品項</th><th>金額</th><th>狀態</th></tr></thead><tbody>${orderRows}</tbody></table></div>` : `<div class="empty">還沒有訂單</div>`}</section><section class="panel"><div class="section-head"><div><span class="eyebrow">PRODUCTS</span><h2 style="margin-top:10px">商品管理</h2><p>新增、修改庫存，或上架／下架商品。</p></div><button class="btn btn-accent" data-action="new-product">＋ 新增商品</button></div>${state.products.length ? `<div class="table-wrap"><table class="admin-table"><thead><tr><th>商品</th><th>售價</th><th>庫存</th><th>操作</th></tr></thead><tbody>${productRows}</tbody></table></div>` : `<div class="empty">尚未建立商品</div>`}</section></main>`;
}

function footer() { return `<footer>NewShop日本連線代購 <span style="float:right">會員與訂單由 Supabase 安全保存</span></footer>`; }

function cartModal() {
  return `<div class="modal-backdrop"><div class="modal"><div class="modal-head"><div><span class="eyebrow">YOUR BAG</span><h2>購物袋</h2></div><button class="close" data-action="close">×</button></div>${state.cart.length ? `${state.cart.map((item) => `<div class="order"><div><strong>${esc(item.name)}</strong><div style="font-size:13px;color:var(--muted)">${money(item.price)} × ${item.qty}</div></div><button class="btn" data-remove="${item.id}" style="background:#f0eee6">移除</button></div>`).join('')}<div style="display:flex;justify-content:space-between;margin:20px 0;font-size:18px"><strong>合計</strong><strong>${money(cartTotal())}</strong></div><button class="btn btn-primary" style="width:100%" data-action="begin-checkout">前往結帳</button>` : `<div class="empty">購物袋還是空的</div>`}</div></div>`;
}

function authModal() {
  const register = state.authMode === 'register';
  return `<div class="modal-backdrop"><div class="modal"><div class="modal-head"><div><span class="eyebrow">MEMBER</span><h2>${register ? '使用 Email 註冊' : '會員登入'}</h2></div><button class="close" data-action="close">×</button></div><div class="auth-tabs"><button class="${!register ? 'active' : ''}" data-auth-mode="login">登入</button><button class="${register ? 'active' : ''}" data-auth-mode="register">註冊</button></div><div class="field"><label>Email</label><input id="email" type="email" autocomplete="email" placeholder="you@example.com" /></div><div class="field"><label>密碼</label><input id="password" type="password" autocomplete="${register ? 'new-password' : 'current-password'}" placeholder="至少 6 個字元" /></div><button class="btn btn-primary" style="width:100%" data-action="${register ? 'signup' : 'login'}" ${state.busy ? 'disabled' : ''}>${state.busy ? '處理中…' : register ? '建立帳號' : '登入'}</button>${register ? '' : `<button class="forgot-link" data-action="forgot-password">忘記密碼？</button>`}<p style="font-size:12px;color:var(--muted);margin:14px 0 0">密碼由 Supabase Auth 加密管理，NewShop 不會保存明文密碼。</p></div></div>`;
}

function forgotPasswordModal() {
  return `<div class="modal-backdrop"><div class="modal"><div class="modal-head"><div><span class="eyebrow">PASSWORD RESET</span><h2>重設密碼</h2></div><button class="close" data-action="close">×</button></div><p style="color:var(--muted);line-height:1.7">輸入註冊 Email，我們會寄送密碼重設連結。</p><div class="field"><label>Email</label><input id="recover-email" type="email" autocomplete="email" placeholder="you@example.com" /></div><button class="btn btn-primary" style="width:100%" data-action="send-recovery" ${state.busy ? 'disabled' : ''}>${state.busy ? '寄送中…' : '寄送重設信'}</button><button class="forgot-link" data-action="back-login">返回登入</button></div></div>`;
}

function newPasswordModal() {
  return `<div class="modal-backdrop"><div class="modal"><div class="modal-head"><div><span class="eyebrow">NEW PASSWORD</span><h2>設定新密碼</h2></div></div><div class="field"><label>新密碼</label><input id="new-password" type="password" autocomplete="new-password" placeholder="至少 6 個字元" /></div><div class="field"><label>再次輸入</label><input id="confirm-password" type="password" autocomplete="new-password" placeholder="再次輸入新密碼" /></div><button class="btn btn-primary" style="width:100%" data-action="update-password" ${state.busy ? 'disabled' : ''}>${state.busy ? '更新中…' : '更新密碼'}</button></div></div>`;
}

function checkoutModal() {
  return `<div class="modal-backdrop"><div class="modal"><div class="modal-head"><div><span class="eyebrow">CHECKOUT</span><h2>確認訂單</h2></div><button class="close" data-action="close">×</button></div><div class="field"><label>收件人</label><input id="customer" autocomplete="name" placeholder="請輸入姓名" /></div><div class="field"><label>聯絡電話</label><input id="phone" autocomplete="tel" placeholder="09xx-xxx-xxx" /></div><div class="field"><label>取貨方式</label><select id="delivery"><option>面交取貨</option><option>宅配到府</option></select></div><div class="field"><label>訂單備註</label><input id="note" placeholder="尺寸、顏色或其他需求（選填）" /></div><button class="btn btn-accent" style="width:100%" data-action="checkout" ${state.busy ? 'disabled' : ''}>${state.busy ? '送出中…' : `送出訂單・${money(cartTotal())}`}</button></div></div>`;
}

function productModal() {
  const product = state.products.find((item) => item.id === state.editingProductId);
  return `<div class="modal-backdrop"><div class="modal product-modal"><div class="modal-head"><div><span class="eyebrow">PRODUCT EDITOR</span><h2>${product ? '編輯商品' : '新增商品'}</h2></div><button class="close" data-action="close">×</button></div><div class="field"><label>商品名稱</label><input id="product-name" value="${esc(product?.name || '')}" maxlength="100" /></div><div class="field"><label>商品說明</label><textarea id="product-description" rows="3" maxlength="1000">${esc(product?.description || '')}</textarea></div><div class="form-grid"><div class="field"><label>售價（NT$）</label><input id="product-price" type="number" min="0" step="1" value="${product?.price ?? ''}" /></div><div class="field"><label>庫存</label><input id="product-stock" type="number" min="0" step="1" value="${product?.stock ?? 0}" /></div></div><div class="field"><label>商品圖片（JPG、PNG、WebP，最大 5MB）</label><input id="product-image" type="file" accept="image/jpeg,image/png,image/webp,image/gif" /></div>${product?.image_url ? `<div class="image-preview"><img src="${esc(product.image_url)}" alt="目前商品圖片"/><span>沒有選新圖時，會保留這張圖。</span></div>` : ''}<label class="check-field"><input id="product-active" type="checkbox" ${product?.is_active === false ? '' : 'checked'} /> 建立後立即上架</label><button class="btn btn-primary" style="width:100%" data-action="save-product" ${state.busy ? 'disabled' : ''}>${state.busy ? '儲存中…' : '儲存商品'}</button></div></div>`;
}

function modal() {
  if (state.modal === 'cart') return cartModal();
  if (state.modal === 'auth') return authModal();
  if (state.modal === 'forgot') return forgotPasswordModal();
  if (state.modal === 'new-password') return newPasswordModal();
  if (state.modal === 'checkout') return checkoutModal();
  if (state.modal === 'product') return productModal();
  return '';
}

function render() {
  const content = state.view === 'shop' ? shop() : state.view === 'orders' ? ordersView() : adminView();
  document.querySelector('#app').innerHTML = `<div class="shell">${nav()}${content}${footer()}</div>${state.modal ? modal() : ''}${state.toast ? `<div class="toast">${esc(state.toast)}</div>` : ''}`;
  bind();
}

function addToCart(id) {
  const product = state.products.find((item) => item.id === id);
  if (!product || !product.is_active || product.stock <= 0) return;
  const item = state.cart.find((entry) => entry.id === id);
  if (item && item.qty >= product.stock) { renderToast('已達目前可購買庫存'); return; }
  if (item) item.qty += 1;
  else state.cart.push({ id: product.id, name: product.name, price: Number(product.price), qty: 1, stock: product.stock });
  saveCart(); renderToast(`${product.name} 已加入購物袋`);
}

async function signup() {
  const email = document.querySelector('#email')?.value.trim();
  const password = document.querySelector('#password')?.value || '';
  if (!email || password.length < 6) { renderToast('請填寫 Email 及至少 6 個字元的密碼'); return; }
  state.busy = true; render();
  const emailRedirectTo = `${window.location.origin}${window.location.pathname}`;
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo },
  });
  state.busy = false;
  if (error) { renderToast(friendlyError(error)); return; }
  state.modal = null;
  renderToast(data.session ? '註冊成功，已登入會員' : '註冊成功，請到信箱點擊驗證連結');
}

async function login() {
  const email = document.querySelector('#email')?.value.trim();
  const password = document.querySelector('#password')?.value || '';
  if (!email || !password) { renderToast('請填寫信箱與密碼'); return; }
  state.busy = true; render();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  state.busy = false;
  if (error) { renderToast(friendlyError(error)); return; }
  state.modal = null; state.view = 'orders'; renderToast('登入成功');
}

async function sendRecovery() {
  const email = document.querySelector('#recover-email')?.value.trim();
  if (!email) { renderToast('請輸入註冊 Email'); return; }
  state.busy = true; render();
  const redirectTo = `${window.location.origin}${window.location.pathname}`;
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
  state.busy = false;
  if (error) { renderToast(friendlyError(error)); return; }
  state.modal = null;
  renderToast('重設信已寄出，請檢查 Email');
}

async function updatePassword() {
  const password = document.querySelector('#new-password')?.value || '';
  const confirmation = document.querySelector('#confirm-password')?.value || '';
  if (password.length < 6) { renderToast('新密碼至少需要 6 個字元'); return; }
  if (password !== confirmation) { renderToast('兩次輸入的密碼不一致'); return; }
  state.busy = true; render();
  const { error } = await supabase.auth.updateUser({ password });
  state.busy = false;
  if (error) { renderToast(friendlyError(error)); return; }
  state.modal = null;
  state.view = 'orders';
  renderToast('密碼更新成功');
}

async function checkout() {
  const recipient = document.querySelector('#customer')?.value.trim();
  const phone = document.querySelector('#phone')?.value.trim();
  const delivery = document.querySelector('#delivery')?.value;
  const note = document.querySelector('#note')?.value.trim() || '';
  if (!recipient || !phone) { renderToast('請填寫收件人與電話'); return; }
  state.busy = true; render();
  const { error } = await supabase.rpc('place_order', { p_recipient_name: recipient, p_phone: phone, p_delivery_method: delivery, p_note: note, p_items: state.cart.map((item) => ({ product_id: item.id, quantity: item.qty })) });
  state.busy = false;
  if (error) { renderToast(friendlyError(error)); return; }
  state.cart = []; saveCart(); state.modal = null; state.view = 'orders';
  await Promise.all([loadOrders(), loadProducts()]);
  renderToast('訂單已送出，我們會盡快確認！');
}

async function uploadProductImage(file) {
  if (!file) return null;
  if (!file.type.startsWith('image/')) throw new Error('請選擇圖片檔案');
  if (file.size > 5 * 1024 * 1024) throw new Error('圖片不能超過 5MB');
  const extension = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
  const path = `${state.user.id}/${crypto.randomUUID()}.${extension || 'jpg'}`;
  const { error } = await supabase.storage.from('product-images').upload(path, file, { contentType: file.type, upsert: false });
  if (error) throw error;
  return supabase.storage.from('product-images').getPublicUrl(path).data.publicUrl;
}

async function saveProduct() {
  if (!isManager()) return;
  const name = document.querySelector('#product-name')?.value.trim();
  const description = document.querySelector('#product-description')?.value.trim() || '';
  const price = Number(document.querySelector('#product-price')?.value);
  const stock = Number(document.querySelector('#product-stock')?.value);
  const isActive = Boolean(document.querySelector('#product-active')?.checked);
  const file = document.querySelector('#product-image')?.files?.[0] || null;
  if (!name || !Number.isFinite(price) || price < 0 || !Number.isInteger(stock) || stock < 0) {
    renderToast('請正確填寫商品名稱、價格與庫存'); return;
  }
  state.busy = true; render();
  try {
    const existing = state.products.find((item) => item.id === state.editingProductId);
    const imageUrl = await uploadProductImage(file);
    const payload = { name, description, price, stock, is_active: isActive };
    if (imageUrl) payload.image_url = imageUrl;
    else if (!existing) payload.image_url = null;
    const query = existing ? supabase.from('products').update(payload).eq('id', existing.id) : supabase.from('products').insert(payload);
    const { error } = await query;
    if (error) throw error;
    await loadProducts();
    state.modal = null; state.editingProductId = null;
    renderToast(existing ? '商品已更新' : '商品已建立');
  } catch (error) {
    renderToast(friendlyError(error));
  } finally {
    state.busy = false; render();
  }
}

async function toggleProduct(id) {
  if (!isManager()) return;
  const product = state.products.find((item) => item.id === id);
  if (!product) return;
  const { error } = await supabase.from('products').update({ is_active: !product.is_active }).eq('id', id);
  if (error) { renderToast(friendlyError(error)); return; }
  await loadProducts();
  renderToast(product.is_active ? '商品已下架' : '商品已上架');
}

async function updateOrderStatus(id, status) {
  if (!isManager() || !statusLabels[status]) return;
  const { error } = await supabase.from('orders').update({ status }).eq('id', id);
  if (error) { renderToast(friendlyError(error)); return; }
  await loadOrders();
  renderToast('訂單狀態已更新');
}

function exportCsv() {
  const rows = [['訂單編號', '日期', '收件人', '電話', '取貨方式', '品項', '數量', '單價', '小計', '訂單總額', '狀態'], ...state.orders.flatMap((order) => (order.order_items || []).map((item) => [order.order_number, new Date(order.created_at).toLocaleString('zh-TW'), order.recipient_name, order.phone, order.delivery_method, item.product_name, item.quantity, item.unit_price, item.subtotal, order.total_amount, statusLabels[order.status] || order.status]))];
  const csv = '\ufeff' + rows.map((row) => row.map((value) => `"${String(value ?? '').replaceAll('"', '""')}"`).join(',')).join('\n');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  link.download = `NewShop日本連線代購訂單-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click(); URL.revokeObjectURL(link.href);
}

function bind() {
  document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', async () => { state.view = button.dataset.view; if ((state.view === 'orders' || state.view === 'admin') && state.user) await loadOrders(); render(); }));
  document.querySelectorAll('[data-scroll]').forEach((button) => button.addEventListener('click', () => document.querySelector('#products')?.scrollIntoView({ behavior: 'smooth' })));
  document.querySelectorAll('[data-add]').forEach((button) => button.addEventListener('click', () => addToCart(button.dataset.add)));
  document.querySelector('[data-action="cart"]')?.addEventListener('click', () => { state.modal = 'cart'; render(); });
  document.querySelectorAll('[data-modal]').forEach((button) => button.addEventListener('click', () => { state.authMode = 'login'; state.modal = button.dataset.modal; render(); }));
  document.querySelectorAll('[data-remove]').forEach((button) => button.addEventListener('click', () => { state.cart = state.cart.filter((item) => item.id !== button.dataset.remove); saveCart(); render(); }));
  document.querySelectorAll('[data-action="close"]').forEach((button) => button.addEventListener('click', () => { state.modal = null; render(); }));
  document.querySelectorAll('[data-auth-mode]').forEach((button) => button.addEventListener('click', () => { state.authMode = button.dataset.authMode; render(); }));
  document.querySelector('[data-action="signup"]')?.addEventListener('click', signup);
  document.querySelector('[data-action="login"]')?.addEventListener('click', login);
  document.querySelector('[data-action="forgot-password"]')?.addEventListener('click', () => { state.modal = 'forgot'; render(); });
  document.querySelector('[data-action="back-login"]')?.addEventListener('click', () => { state.authMode = 'login'; state.modal = 'auth'; render(); });
  document.querySelector('[data-action="send-recovery"]')?.addEventListener('click', sendRecovery);
  document.querySelector('[data-action="update-password"]')?.addEventListener('click', updatePassword);
  document.querySelector('[data-action="logout"]')?.addEventListener('click', async () => { await supabase.auth.signOut(); state.view = 'shop'; renderToast('已登出'); });
  document.querySelector('[data-action="begin-checkout"]')?.addEventListener('click', () => { if (!state.user) { state.authMode = 'login'; state.modal = 'auth'; renderToast('請先登入，再送出訂單'); return; } state.modal = 'checkout'; render(); });
  document.querySelector('[data-action="checkout"]')?.addEventListener('click', checkout);
  document.querySelector('[data-action="export"]')?.addEventListener('click', exportCsv);
  document.querySelector('[data-action="new-product"]')?.addEventListener('click', () => { state.editingProductId = null; state.modal = 'product'; render(); });
  document.querySelectorAll('[data-edit-product]').forEach((button) => button.addEventListener('click', () => { state.editingProductId = button.dataset.editProduct; state.modal = 'product'; render(); }));
  document.querySelectorAll('[data-toggle-product]').forEach((button) => button.addEventListener('click', () => toggleProduct(button.dataset.toggleProduct)));
  document.querySelector('[data-action="save-product"]')?.addEventListener('click', saveProduct);
  document.querySelectorAll('[data-order-status]').forEach((select) => select.addEventListener('change', () => updateOrderStatus(select.dataset.orderStatus, select.value)));
}

render();
initialize();
