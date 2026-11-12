/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
/**
 * Nova layout v3 behaviour (NOVA-UI-3, 4, 5, 6, 13, 14).
 * Menu markup comes from the server (services/nova_menu.js). Items with
 * data-nova-action are handled by app.js as before; this file only handles
 * data-nova-v3 items, the expandable groups, phone sheets and the extra panels.
 */
(function () {
  'use strict';

  const GROUP_KEY = 'nova_v3_group_';
  const NOTE_KEY = 'nova_v3_where_note_dismissed';

  const isPhone = () => window.innerWidth < 768 && !(window.NovaGestures && document.documentElement.getAttribute('data-nova-device') === 'fold-unfolded');
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    let data = {};
    try { data = await res.json(); } catch (e) {}
    if (!res.ok || data.success === false) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  /* ---------------- Groups (desktop sidebar) ---------------- */
  function setGroup(btn, open, save) {
    const body = document.getElementById(btn.getAttribute('aria-controls'));
    btn.setAttribute('aria-expanded', String(open));
    if (body) body.hidden = !open;
    const group = btn.closest('.nova-v3-group');
    if (save && group) {
      try { localStorage.setItem(GROUP_KEY + group.getAttribute('data-group-id'), open ? 'open' : 'closed'); } catch (e) {}
    }
  }

  function restoreGroups() {
    $$('.nova-v3-group-btn').forEach((btn) => {
      const id = btn.closest('.nova-v3-group').getAttribute('data-group-id');
      let saved = null;
      try { saved = localStorage.getItem(GROUP_KEY + id); } catch (e) {}
      if (saved === 'open') setGroup(btn, true, false);
      else if (saved === 'closed') setGroup(btn, false, false);
    });
  }

  function openGroup(id) {
    if (isPhone() && id !== 'chats') { openSheet(id); return; }
    const btn = $(`.nova-v3-group[data-group-id="${id}"] .nova-v3-group-btn`);
    if (!btn) return;
    setGroup(btn, true, true);
    btn.focus();
  }

  // Arrow keys move between the visible controls in the sidebar (NOVA-UI-3)
  function bindSidebarKeys() {
    const sidebar = $('.nova-v3-sidebar');
    if (!sidebar) return;
    sidebar.addEventListener('keydown', (e) => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
      const target = e.target;
      if (!target.matches('.nova-v3-group-btn, .nova-v3-item, .nova-agent-row, [data-conv-id]')) return;
      const all = $$('.nova-v3-group-btn, .nova-v3-item, .nova-agent-row, [data-conv-id]', sidebar)
        .filter((el) => el.offsetParent !== null);
      const idx = all.indexOf(target);
      if (idx === -1) return;
      e.preventDefault();
      e.stopPropagation(); // app.js also uses arrows on persona rows to switch persona; here arrows only move focus
      let next = idx;
      if (e.key === 'ArrowDown') next = Math.min(all.length - 1, idx + 1);
      if (e.key === 'ArrowUp') next = Math.max(0, idx - 1);
      if (e.key === 'Home') next = 0;
      if (e.key === 'End') next = all.length - 1;
      all[next].focus();
    });
  }

  /* ---------------- Phone sheets ---------------- */
  let lastSheetOpener = null;

  function closeSheets() {
    $$('.nova-v3-sheet').forEach((s) => { s.hidden = true; });
    const backdrop = $('#novaV3SheetBackdrop');
    if (backdrop) backdrop.hidden = true;
    $$('.nova-v3-tab').forEach((t) => t.setAttribute('aria-expanded', 'false'));
    if (lastSheetOpener && document.contains(lastSheetOpener)) lastSheetOpener.focus();
    lastSheetOpener = null;
  }

  function openSheet(id, opener) {
    const sheet = document.getElementById('novaV3Sheet-' + id);
    if (!sheet) return;
    const wasOpen = !sheet.hidden;
    closeSheets();
    if (wasOpen) return;
    if (window.NovaGestures) window.NovaGestures.closeMobileDrawers();
    lastSheetOpener = opener || null;
    sheet.hidden = false;
    const backdrop = $('#novaV3SheetBackdrop');
    if (backdrop) backdrop.hidden = false;
    if (opener) opener.setAttribute('aria-expanded', 'true');
    const first = $('.nova-v3-item, .nova-v3-icon-btn', sheet);
    if (first) first.focus();
  }

  function bindSheetSwipe() {
    let startY = 0;
    let sheet = null;
    document.addEventListener('touchstart', (e) => {
      sheet = e.target.closest && e.target.closest('.nova-v3-sheet');
      if (sheet && e.touches.length === 1 && sheet.scrollTop <= 2) startY = e.touches[0].clientY;
      else sheet = null;
    }, { passive: true });
    document.addEventListener('touchend', (e) => {
      if (sheet && e.changedTouches.length === 1 && e.changedTouches[0].clientY - startY > 70) closeSheets();
      sheet = null;
    }, { passive: true });
  }

  /* ---------------- Workspace panel (NOVA-UI-5) ---------------- */
  const WORKSPACE_TARGETS = {
    persona: '#novaInfoPersonaName',
    routines: '#novaRoutinesList',
    memory: '#novaMemoryPreviewList',
    usage: '#novaUsageBars',
    connectors: '#novaConnectorsList',
    activity: '#novaActivityList',
    chats: '#novaPastChatsList'
  };

  function showInfoPane() {
    const pane = $('#novaInfoPane');
    if (!pane) return null;
    if (pane.classList.contains('is-hidden')) {
      // Use app.js's own toggle so usage/activity refresh exactly as in v2
      const toggle = $('[data-nova-action="toggle-info-pane"]');
      if (toggle) toggle.click();
      else pane.classList.remove('is-hidden');
    }
    return pane;
  }

  function flash(el) {
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.classList.add('nova-v3-flash');
    setTimeout(() => el.classList.remove('nova-v3-flash'), 1400);
  }

  function openWorkspace(section) {
    closeSheets();
    if (window.NovaGestures) window.NovaGestures.closeMobileDrawers();
    const pane = showInfoPane();
    if (!pane) return;
    if (section === 'new-routine') {
      const form = $('#novaNewRoutineForm');
      if (form && form.classList.contains('hidden')) {
        const t = $('[data-nova-action="toggle-new-routine"]');
        if (t) t.click();
      }
      flash(form && form.closest('section'));
      const firstInput = form && $('input, textarea, select', form);
      if (firstInput) setTimeout(() => firstInput.focus(), 250);
      return;
    }
    const anchor = $(WORKSPACE_TARGETS[section] || '');
    flash(anchor && anchor.closest('section'));
  }

  function addPluginsLink() {
    const list = $('#novaConnectorsList');
    if (!list || $('#novaV3PluginsLink')) return;
    const a = document.createElement('a');
    a.id = 'novaV3PluginsLink';
    a.href = '/novaai/plugins';
    a.className = 'nova-v3-item';
    a.innerHTML = '<i data-lucide="plug" aria-hidden="true"></i><span>All plugins &amp; connections</span>';
    list.parentElement.appendChild(a);
  }

  /* ---------------- Settings (NOVA-UI-6) ---------------- */
  const SETTINGS_TARGETS = {
    you: '#novaSettingTheme',
    app: '#novaSettingChannel',
    notifications: '#novaSettingsNotificationsSection',
    privacy: '#novaSettingsModal [data-nova-action="open-memory-view"]'
  };

  function openSettings(section) {
    closeSheets();
    const btn = $('#novaAccountBtn') || $('[data-nova-action="open-settings"]');
    if (btn) btn.click();
    setTimeout(() => {
      const el = $(SETTINGS_TARGETS[section] || '');
      flash(el && (el.closest('section') || el));
    }, 120);
  }

  async function setLayout(useV3) {
    try {
      await api('PATCH', '/api/nova/settings', { novaUiV3: useV3 });
    } catch (e) {
      alert('Could not save your layout choice: ' + e.message);
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.delete('ui');
    window.location.href = url.toString();
  }

  /* ---------------- Admin: computer + telemetry (owner only markup) ---------------- */
  function openComputer(tab) {
    closeSheets();
    const pane = showInfoPane();
    const card = $('#novaComputerCard');
    if (!pane || !card) return;
    if (tab === 'reset') {
      flash(card);
      const reset = $('#novaResetComputerBtn');
      if (reset) reset.focus();
      return;
    }
    const tabBtn = $(`[data-computer-tab="${tab}"]`);
    if (tabBtn) tabBtn.click();
    flash(card);
  }

  async function openTelemetry() {
    closeSheets();
    const modal = $('#novaV3TelemetryModal');
    const body = $('#novaV3TelemetryBody');
    if (!modal || !body) return;
    modal.classList.remove('is-hidden', 'hidden');
    const closeBtn = $('[data-nova-v3="close-telemetry"]', modal);
    if (closeBtn) closeBtn.focus();
    body.textContent = 'Loading…';
    try {
      const d = await api('GET', '/api/telemetry/nodes');
      const nodes = d.nodes || [];
      let html = `<div><span class="nova-v3-stat">Nodes<strong>${Number(d.total_nodes) || 0}</strong></span>` +
        `<span class="nova-v3-stat">Online<strong>${Number(d.active_nodes) || 0}</strong></span>` +
        `<span class="nova-v3-stat">Hashrate<strong>${Math.round(Number(d.total_hashrate_hs) || 0)} H/s</strong></span></div>`;
      if (!nodes.length) {
        html += '<p>No nodes have reported in yet.</p>';
      } else {
        html += '<table><thead><tr><th scope="col">Node</th><th scope="col">Status</th><th scope="col">CPU °C</th><th scope="col">Threads</th><th scope="col">Memory</th></tr></thead><tbody>';
        html += nodes.map((n) => `<tr><td>${escapeHtml(n.node_id)}</td><td>${escapeHtml(n.status)}</td><td>${escapeHtml(n.cpu_temp_c)}</td>` +
          `<td>${escapeHtml(n.active_threads)}/${escapeHtml(n.total_cores)}</td><td>${escapeHtml(n.mem_usage_mb)} MB</td></tr>`).join('');
        html += '</tbody></table>';
      }
      body.innerHTML = html;
    } catch (e) {
      body.textContent = 'Could not load telemetry: ' + e.message;
    }
  }

  function closeTelemetry() {
    const modal = $('#novaV3TelemetryModal');
    if (modal) modal.classList.add('is-hidden', 'hidden');
  }

  /* ---------------- Folders (sections) ---------------- */
  async function renderFolders() {
    const box = $('#novaSectionsContainer');
    if (!box) return;
    try {
      const [s, c] = await Promise.all([api('GET', '/api/nova/sections'), api('GET', '/api/nova/conversations')]);
      const convs = c.conversations || [];
      box.innerHTML = (s.sections || []).map((sec) => {
        const inside = convs.filter((cv) => cv.sectionId === sec.id);
        return `<div class="nova-v3-folder" data-section-id="${escapeHtml(sec.id)}">
          <div class="nova-v3-folder-head">
            <span class="nova-v3-item"><i data-lucide="folder" aria-hidden="true"></i><span>${escapeHtml(sec.name)} (${inside.length})</span></span>
            <button type="button" class="nova-v3-folder-move" data-nova-v3="move-to-folder:${escapeHtml(sec.id)}" aria-label="Move the open chat into ${escapeHtml(sec.name)}">Move here</button>
          </div>
          <div class="nova-v3-folder-chats">${inside.map((cv) => `<button type="button" class="nova-v3-item" data-conv-id="${escapeHtml(cv.id)}"><span>${escapeHtml(cv.title)}</span></button>`).join('')}</div>
        </div>`;
      }).join('');
      if (window.lucide) window.lucide.createIcons();
    } catch (e) {}
  }

  async function newFolder() {
    const name = (window.prompt('Name for the new folder:') || '').trim();
    if (!name) return;
    try {
      await api('POST', '/api/nova/sections', { name });
      openGroup('chats');
      await renderFolders();
    } catch (e) {
      alert('Could not create the folder: ' + e.message);
    }
  }

  async function moveOpenChat(sectionId) {
    const active = $('#novaConversationList [data-conv-id].font-semibold, #novaConversationList [data-conv-id][aria-current="true"]');
    if (!active) { alert('Open a chat first, then press "Move here".'); return; }
    try {
      await api('PATCH', `/api/nova/conversations/${encodeURIComponent(active.getAttribute('data-conv-id'))}`, { sectionId });
      await renderFolders();
    } catch (e) {
      alert('Could not move the chat: ' + e.message);
    }
  }

  /* ---------------- "Where did it go?" (NOVA-UI-14) ---------------- */
  function maybeShowNote() {
    const note = $('#novaV3WhereNote');
    if (!note) return;
    let dismissed = false;
    try { dismissed = localStorage.getItem(NOTE_KEY) === '1'; } catch (e) {}
    note.hidden = dismissed;
  }

  function dismissNote() {
    const note = $('#novaV3WhereNote');
    if (note) note.hidden = true;
    try { localStorage.setItem(NOTE_KEY, '1'); } catch (e) {}
  }

  /* ---------------- Dispatcher ---------------- */
  function handle(cmd, el) {
    const [kind, arg] = cmd.split(':');
    switch (kind) {
      case 'open-group': return openGroup(arg);
      case 'drawer':
        closeSheets();
        if (window.NovaGestures) { window.NovaGestures.setMobileViewMode('list'); window.NovaGestures.openMobileSidebar(); }
        return undefined;
      case 'close-drawer': return window.NovaGestures && window.NovaGestures.closeMobileDrawers();
      case 'sheet': return openSheet(arg, el);
      case 'close-sheet': return closeSheets();
      case 'workspace': return openWorkspace(arg);
      case 'settings': return openSettings(arg);
      case 'layout': return setLayout(arg === 'v3');
      case 'computer': return openComputer(arg);
      case 'admin': return arg === 'telemetry' ? openTelemetry() : undefined;
      case 'close-telemetry': return closeTelemetry();
      case 'new-section': return newFolder();
      case 'move-to-folder': return moveOpenChat(arg);
      case 'dismiss-note': return dismissNote();
      default: return undefined;
    }
  }

  function init() {
    if (!document.body.classList.contains('nova-v3')) return;

    document.addEventListener('click', (e) => {
      const groupBtn = e.target.closest('.nova-v3-group-btn');
      if (groupBtn) {
        setGroup(groupBtn, groupBtn.getAttribute('aria-expanded') !== 'true', true);
        return;
      }
      const v3 = e.target.closest('[data-nova-v3]');
      if (v3) {
        e.preventDefault();
        handle(v3.getAttribute('data-nova-v3'), v3);
        return;
      }
      if (e.target.id === 'novaV3SheetBackdrop') { closeSheets(); return; }
      if (e.target.id === 'novaV3TelemetryModal') { closeTelemetry(); return; }
      // Any normal action picked from a phone sheet closes the sheet
      if (e.target.closest('.nova-v3-sheet [data-nova-action], .nova-v3-sheet a[href]')) closeSheets();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if ($('.nova-v3-sheet:not([hidden])')) closeSheets();
      closeTelemetry();
    });

    restoreGroups();
    bindSidebarKeys();
    bindSheetSwipe();
    addPluginsLink();
    renderFolders();
    maybeShowNote();
    if (window.lucide) window.lucide.createIcons();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.NovaV3 = { openSheet, closeSheets, openWorkspace, openSettings, openGroup };
})();
