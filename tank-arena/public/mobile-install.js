(() => {
  'use strict';

  const install = document.getElementById('tank-install');
  const strip = document.getElementById('tank-install-strip');
  const help = document.getElementById('tank-install-help');
  const message = document.getElementById('tank-install-message');
  const close = document.getElementById('tank-install-close');
  const standaloneQuery = window.matchMedia?.('(display-mode: standalone)');
  let deferredPrompt = null;
  let installed = false;

  function isStandalone() {
    return installed || standaloneQuery?.matches || navigator.standalone === true;
  }

  function updateInstall() {
    const hidden = Boolean(isStandalone());
    if (install) install.hidden = hidden;
    if (strip) strip.hidden = hidden;
  }

  function showHelp() {
    if (!help || !message) return;
    const agent = navigator.userAgent || '';
    const ios = /iPad|iPhone|iPod/.test(agent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (/MicroMessenger|QQ\//i.test(agent)) {
      message.textContent = '请先点右上角菜单，在系统浏览器中打开。然后使用浏览器的「添加到主屏幕」或「安装应用」。添加后仍需要联网进行对战。';
    } else if (ios) {
      message.textContent = '在 Safari 中打开这个链接，轻点「分享」，选择「添加到主屏幕」，再点「添加」。之后可从桌面的坦克图标直接进入游戏，联机对战需要网络。';
    } else if (/Android/i.test(agent)) {
      message.textContent = '打开浏览器右上角菜单，选择「安装应用」或「添加到主屏幕」。如果没有该选项，可用最新版 Chrome 或 Edge 打开游戏。添加后仍需要联网进行对战。';
    } else {
      message.textContent = '可在 Chrome 或 Edge 的地址栏、浏览器菜单中选择「安装应用」。手机上打开同一个游戏链接，也可以添加到主屏幕。安装后仍需要联网进行对战。';
    }
    document.dispatchEvent(new Event('tank-install-open'));
    if (typeof help.showModal === 'function') {
      if (!help.open) help.showModal();
    } else {
      help.setAttribute('open', '');
    }
  }

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    deferredPrompt = event;
    updateInstall();
  });

  window.addEventListener('appinstalled', () => {
    installed = true;
    deferredPrompt = null;
    updateInstall();
  });
  standaloneQuery?.addEventListener?.('change', updateInstall);

  install?.addEventListener('click', async () => {
    if (!deferredPrompt) {
      showHelp();
      return;
    }
    const prompt = deferredPrompt;
    deferredPrompt = null;
    install.disabled = true;
    document.dispatchEvent(new Event('tank-install-open'));
    try {
      // Browsers require this call to remain inside a user-initiated click.
      await prompt.prompt();
      await prompt.userChoice;
    } catch (_) {
      showHelp();
    } finally {
      install.disabled = false;
      document.dispatchEvent(new Event('tank-install-close'));
      updateInstall();
    }
  });

  close?.addEventListener('click', () => {
    if (typeof help?.close === 'function') help.close();
    else {
      help?.removeAttribute('open');
      document.dispatchEvent(new Event('tank-install-close'));
    }
  });
  help?.addEventListener('close', () => document.dispatchEvent(new Event('tank-install-close')));
  updateInstall();

  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('/games/tanks/sw.js', {
      scope: '/games/tanks/', updateViaCache: 'none',
    }).catch(() => {
      // Optional installation/offline support must never prevent online gameplay.
    });
  }
})();
