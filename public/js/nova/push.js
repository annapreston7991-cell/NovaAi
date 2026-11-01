/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
/**
 * Nova Web Push Client Controller (§15.5)
 * - Requests Notification permission only when user toggles a preference on or clicks Send test notification
 * - Subscribes via Service Worker pushManager with VAPID public key
 * - Syncs per-persona toggles (`onTaskDone`, `onApproval`) with `/api/nova/push/prefs`
 */
(function () {
  'use strict';

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  function setPushNote(msg, isError = false) {
    const el = document.getElementById('novaPushStatusNote');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('hidden', 'text-rose-400', 'text-cyan-300');
    el.classList.add(isError ? 'text-rose-400' : 'text-cyan-300');
  }

  async function ensureBrowserPushSubscription() {
    if (!('Notification' in window) || !('serviceWorker' in navigator)) {
      return false;
    }
    let perm = Notification.permission;
    if (perm === 'default') {
      perm = await Notification.requestPermission();
    }
    if (perm !== 'granted') {
      setPushNote('Notification permission was not granted in your browser.', true);
      return false;
    }

    try {
      const keyRes = await fetch('/api/nova/push/vapid-key', { credentials: 'same-origin' });
      const keyData = await keyRes.json();
      if (!keyData || !keyData.publicKey) return false;

      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(keyData.publicKey)
        });
      }
      await fetch('/api/nova/push/subscribe', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub)
      });
      return true;
    } catch (err) {
      return false;
    }
  }

  async function loadPushPrefs() {
    try {
      const res = await fetch('/api/nova/push/prefs', { credentials: 'same-origin' });
      if (!res.ok) return;
      const data = await res.json();
      if (!data || !data.prefs) return;

      document.querySelectorAll('[data-push-pref-persona]').forEach((input) => {
        const p = input.getAttribute('data-push-pref-persona');
        const field = input.getAttribute('data-push-pref-field');
        if (data.prefs[p] && typeof data.prefs[p][field] === 'boolean') {
          input.checked = data.prefs[p][field];
        }
      });
    } catch (e) {}
  }

  document.addEventListener('change', async (ev) => {
    const input = ev.target.closest('[data-push-pref-persona]');
    if (!input) return;

    const persona = input.getAttribute('data-push-pref-persona');
    const field = input.getAttribute('data-push-pref-field');
    const checked = input.checked;

    if (checked) {
      await ensureBrowserPushSubscription();
    }

    try {
      const body = { persona };
      body[field] = checked;
      const res = await fetch('/api/nova/push/prefs', {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (res.ok) {
        setPushNote(`Saved notification preferences for ${persona.toUpperCase()}.`);
      }
    } catch (err) {
      setPushNote('Failed to save push preferences.', true);
    }
  });

  document.addEventListener('click', async (ev) => {
    const testBtn = ev.target.closest('[data-nova-action="send-test-push"]');
    if (!testBtn) return;
    ev.preventDefault();

    await ensureBrowserPushSubscription();
    try {
      const res = await fetch('/api/nova/push/test', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ persona: 'nova' })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setPushNote(`Test notification dispatched (${data.sent || 0} device(s)).`);
      } else {
        setPushNote((data && data.error) || 'Could not send test notification.', true);
      }
    } catch (e) {
      setPushNote('Error sending test notification.', true);
    }
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      const d = event.data || {};
      if (d.type === 'NOVA_NOTIFICATION_CLICK' && d.url) {
        window.location.href = d.url;
      }
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    loadPushPrefs();
  });

  window.NovaPush = {
    loadPushPrefs,
    ensureBrowserPushSubscription
  };
})();
