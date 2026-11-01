/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
/**
 * Nova PWA Install & Service Worker Update Controller (§3.6, §14)
 * Handles beforeinstallprompt, standalone detection, iOS Add-to-Home-Screen sheet,
 * dismissible /app browser banner, and SW "New version ready · Reload" bar.
 */
(function () {
  'use strict';

  let deferredPrompt = null;

  function isStandaloneMode() {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true
    );
  }

  function isIosDevice() {
    const ua = window.navigator.userAgent || '';
    const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    return isIOS;
  }

  function syncInstallVisibility() {
    const installed = isStandaloneMode();
    document.querySelectorAll('[data-nova-install-container]').forEach((el) => {
      if (installed) {
        el.classList.add('hidden');
      } else {
        el.classList.remove('hidden');
      }
    });

    const appBanner = document.getElementById('novaAppInstallBanner');
    if (appBanner) {
      let dismissed = false;
      try {
        dismissed = sessionStorage.getItem('nova_install_banner_dismissed') === '1';
      } catch (e) {}
      if (installed || dismissed) {
        appBanner.classList.add('hidden');
      } else {
        appBanner.classList.remove('hidden');
      }
    }
  }

  function openIosInstallSheet() {
    let modal = document.getElementById('novaIosInstallModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'novaIosInstallModal';
      modal.className = 'nova-command-backdrop';
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      modal.setAttribute('aria-labelledby', 'novaIosInstallTitle');
      modal.innerHTML = `
        <div class="w-full max-w-md rounded-2xl bg-slate-900 border border-white/15 shadow-2xl p-5 space-y-4 text-xs text-slate-200">
          <div class="flex items-center justify-between border-b border-white/10 pb-3">
            <div class="flex items-center gap-2.5">
              <img src="/images/nova-icon.jpg?v=20260925" alt="Nova icon" class="w-8 h-8 rounded-xl object-cover border border-cyan-500/40" />
              <div>
                <h2 id="novaIosInstallTitle" class="text-sm font-bold text-white">Install Nova on iPhone or iPad</h2>
                <p class="text-[11px] text-slate-400">Standalone full-screen app experience</p>
              </div>
            </div>
            <button type="button" data-close-ios-install class="p-2 rounded-lg bg-white/5 text-slate-400 hover:text-white min-w-[44px] min-h-[44px] flex items-center justify-center" aria-label="Close install instructions">✕</button>
          </div>
          <ol class="space-y-2.5 list-decimal list-inside text-slate-200 leading-relaxed">
            <li>Tap the <strong>Share</strong> button <span class="font-mono text-cyan-300">[↑]</span> in Safari’s toolbar.</li>
            <li>Scroll down and tap <strong>Add to Home Screen</strong>.</li>
            <li>Tap <strong>Add</strong> in the top-right corner to launch <strong>Nova</strong> standalone.</li>
          </ol>
          <div class="pt-3 border-t border-white/10 flex flex-col gap-2">
            <a href="/nova-app.mobileconfig" download class="w-full py-2.5 px-4 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white font-semibold text-center transition min-h-[44px] flex items-center justify-center">
              Optional: Download iOS Profile (.mobileconfig)
            </a>
            <button type="button" data-close-ios-install class="w-full py-2 px-4 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-slate-300 font-semibold min-h-[44px]">
              Done
            </button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
      modal.addEventListener('click', (ev) => {
        if (ev.target === modal || ev.target.closest('[data-close-ios-install]')) {
          modal.classList.add('is-hidden');
        }
      });
    }
    modal.classList.remove('is-hidden');
  }

  async function triggerInstall() {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      try {
        await deferredPrompt.userChoice;
      } catch (e) {}
      deferredPrompt = null;
      syncInstallVisibility();
      return;
    }
    if (isIosDevice()) {
      openIosInstallSheet();
      return;
    }
    openIosInstallSheet();
  }

  function showSwUpdateToast(worker) {
    let toast = document.getElementById('novaSwUpdateBanner');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'novaSwUpdateBanner';
      toast.setAttribute('role', 'status');
      toast.setAttribute('aria-live', 'polite');
      toast.className = 'fixed bottom-4 right-4 z-50 flex items-center gap-3 px-4 py-2.5 rounded-xl bg-slate-900 border border-cyan-500/40 shadow-2xl text-xs text-slate-100';
      toast.innerHTML = `
        <span>New version ready</span>
        <button type="button" id="novaSwReloadBtn" class="px-2.5 py-1 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-semibold">Reload</button>
      `;
      document.body.appendChild(toast);
      toast.querySelector('#novaSwReloadBtn').addEventListener('click', () => {
        if (worker) {
          worker.postMessage({ type: 'SKIP_WAITING' });
        }
        window.location.reload();
      });
    }
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => {
        if (reg.waiting) {
          showSwUpdateToast(reg.waiting);
        }
        reg.addEventListener('updatefound', () => {
          const nw = reg.installing;
          if (!nw) return;
          nw.addEventListener('statechange', () => {
            if (nw.state === 'installed' && navigator.serviceWorker.controller) {
              showSwUpdateToast(nw);
            }
          });
        });
      })
      .catch(() => {});
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    syncInstallVisibility();
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    syncInstallVisibility();
  });

  document.addEventListener('click', (ev) => {
    const installBtn = ev.target.closest('[data-nova-action="install-app"]');
    if (installBtn) {
      ev.preventDefault();
      triggerInstall();
      return;
    }
    const dismissBtn = ev.target.closest('[data-nova-action="dismiss-install-banner"]');
    if (dismissBtn) {
      ev.preventDefault();
      try {
        sessionStorage.setItem('nova_install_banner_dismissed', '1');
      } catch (e) {}
      syncInstallVisibility();
    }
  });

  document.addEventListener('DOMContentLoaded', () => {
    syncInstallVisibility();
    registerServiceWorker();
  });

  window.NovaInstall = {
    triggerInstall,
    openIosInstallSheet,
    isStandaloneMode
  };
})();
