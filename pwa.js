(() => {
  let installEvent = null;
  const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const hide = () => document.getElementById('native-install')?.remove();
  window.addEventListener('beforeinstallprompt', (event) => {
    // Preserve Chrome's own install promotion. This button invokes the same native dialog.
    installEvent = event;
    if (standalone() || document.getElementById('native-install')) return;
    const button = document.createElement('button');
    button.id = 'native-install';
    button.className = 'pwa-install';
    button.textContent = '↓ 安裝 NewShop App';
    button.addEventListener('click', async () => {
      if (!installEvent) return;
      const pending = installEvent;
      installEvent = null;
      button.disabled = true;
      try { await pending.prompt(); await pending.userChoice; }
      catch (error) { console.warn('Install prompt unavailable', error); }
      finally { hide(); }
    });
    document.body.appendChild(button);
  });
  window.addEventListener('appinstalled', () => { installEvent = null; hide(); });
  if ('serviceWorker' in navigator) {
    const register = () => navigator.serviceWorker.register('/service-worker.js', { updateViaCache: 'none' }).catch(console.warn);
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
  }
})();
