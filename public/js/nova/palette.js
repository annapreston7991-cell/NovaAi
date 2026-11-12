/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
/**
 * Nova Command Palette (Cmd/Ctrl+K) (§3.4, §10)
 */
(function () {
  function initNovaPalette(app) {
    const backdrop = document.getElementById('novaPaletteBackdrop');
    const input = document.getElementById('novaPaletteInput');
    const resultsEl = document.getElementById('novaPaletteResults');
    if (!backdrop || !input || !resultsEl) return;

    let lastFocused = null;
    let debounceTimer = null;

    function open() {
      lastFocused = document.activeElement;
      backdrop.classList.remove('is-hidden');
      input.value = '';
      renderDefaultCommands();
      setTimeout(() => input.focus(), 20);
    }

    function close() {
      backdrop.classList.add('is-hidden');
      if (lastFocused && typeof lastFocused.focus === 'function') {
        lastFocused.focus();
      }
    }

    function escapeHtml(str) {
      return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function renderDefaultCommands() {
      const convs = (app.state.conversations || []).slice(0, 6);
      let html = `
        <div class="px-2.5 py-1 text-[10px] font-mono uppercase tracking-wider text-slate-400">Quick Actions</div>
        <button type="button" data-palette-agent="nova" class="w-full text-left px-3 py-2 rounded-xl hover:bg-white/10 flex items-center justify-between text-xs text-slate-200">
          <span>Switch to <strong>Nova</strong> (guide, builder &amp; companion)</span>
          <span class="text-[10px] font-mono text-cyan-400">#06b6d4</span>
        </button>
        <button type="button" data-palette-agent="astra" class="w-full text-left px-3 py-2 rounded-xl hover:bg-white/10 flex items-center justify-between text-xs text-slate-200">
          <span>Switch to <strong>Astra</strong> (Wonder &amp; Synthesis)</span>
          <span class="text-[10px] font-mono text-purple-400">#c084fc</span>
        </button>
        <button type="button" data-palette-agent="astaria" class="w-full text-left px-3 py-2 rounded-xl hover:bg-white/10 flex items-center justify-between text-xs text-slate-200">
          <span>Switch to <strong>Astaria</strong> (Analyst &amp; Logic)</span>
          <span class="text-[10px] font-mono text-emerald-400">#10b981</span>
        </button>
        <button type="button" data-palette-cmd="toggle-info" class="w-full text-left px-3 py-2 rounded-xl hover:bg-white/10 flex items-center justify-between text-xs text-slate-200">
          <span>Toggle Inspector &amp; Usage Pane</span>
          <kbd class="text-[10px] font-mono text-slate-400">⌘⇧I</kbd>
        </button>
      `;

      if (convs.length > 0) {
        html += `<div class="px-2.5 pt-2 pb-1 text-[10px] font-mono uppercase tracking-wider text-slate-400">Recent Chats</div>`;
        for (const c of convs) {
          html += `
            <button type="button" data-palette-conv="${escapeHtml(c.id)}" class="w-full text-left px-3 py-2 rounded-xl hover:bg-white/10 flex items-center justify-between text-xs text-slate-200">
              <span class="truncate">${escapeHtml(c.title)}</span>
              <span class="text-[10px] font-mono text-slate-400">${escapeHtml(c.agentId || c.type)}</span>
            </button>
          `;
        }
      }
      resultsEl.innerHTML = html;
    }

    // Layout v3 (NOVA-UI-13): menu features are searchable too. window.__NOVA_MENU__ is
    // built on the server for this viewer, so a member never gets Admin items here.
    function menuMatches(q) {
      const menu = Array.isArray(window.__NOVA_MENU__) ? window.__NOVA_MENU__ : [];
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      if (!words.length) return [];
      return menu.filter((item) => {
        const hay = `${item.label} ${item.group}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      }).slice(0, 8);
    }

    function menuHtml(items) {
      if (!items.length) return '';
      let html = `<div class="px-2.5 py-1 text-[10px] font-mono uppercase tracking-wider text-slate-400">Menu</div>`;
      for (const item of items) {
        html += `
          <button type="button" data-palette-menu="${escapeHtml(item.id)}" class="w-full text-left px-3 py-2 rounded-xl hover:bg-white/10 flex items-center justify-between text-xs text-white">
            <span class="truncate">${escapeHtml(item.label)}</span>
            <span class="text-[10px] font-mono text-cyan-300">${escapeHtml(item.group)}</span>
          </button>
        `;
      }
      return html;
    }

    async function runSearch(q) {
      const trimmed = q.trim();
      if (!trimmed) {
        renderDefaultCommands();
        return;
      }
      const menuPart = menuHtml(menuMatches(trimmed));
      if (menuPart) resultsEl.innerHTML = menuPart;
      try {
        const res = await fetch(`/api/nova/search?q=${encodeURIComponent(trimmed)}`, { credentials: 'same-origin' });
        const data = await res.json();
        const convs = data.conversations || [];
        const msgs = data.messages || [];

        let html = menuPart;
        if (convs.length > 0) {
          html += `<div class="px-2.5 py-1 text-[10px] font-mono uppercase tracking-wider text-slate-400">Matching Chats</div>`;
          for (const c of convs) {
            html += `
              <button type="button" data-palette-conv="${escapeHtml(c.id)}" class="w-full text-left px-3 py-2 rounded-xl hover:bg-white/10 flex items-center justify-between text-xs text-white">
                <span class="truncate">${escapeHtml(c.title)}</span>
                <span class="text-[10px] font-mono text-cyan-400">${escapeHtml(c.agentId || c.type)}</span>
              </button>
            `;
          }
        }
        if (msgs.length > 0) {
          html += `<div class="px-2.5 pt-2 pb-1 text-[10px] font-mono uppercase tracking-wider text-slate-400">Matching Messages</div>`;
          for (const m of msgs) {
            html += `
              <button type="button" data-palette-conv="${escapeHtml(m.conversationId)}" class="w-full text-left px-3 py-2 rounded-xl hover:bg-white/10 flex flex-col gap-0.5 text-xs text-slate-200">
                <span class="font-semibold text-white truncate">${escapeHtml(m.conversationTitle || 'Chat')}</span>
                <span class="text-[11px] text-slate-400 truncate">${escapeHtml(m.snippet)}</span>
              </button>
            `;
          }
        }
        if (!html) {
          html = `<div class="p-4 text-center text-xs text-slate-400">No chats or messages found for "${escapeHtml(trimmed)}".</div>`;
        }
        if (input.value.trim() === trimmed) resultsEl.innerHTML = html;
      } catch (e) {}
    }

    input.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => runSearch(input.value), 140);
    });

    resultsEl.addEventListener('click', (e) => {
      const menuBtn = e.target.closest('[data-palette-menu]');
      if (menuBtn) {
        const id = menuBtn.getAttribute('data-palette-menu');
        close();
        // Reuse the real menu item so it behaves exactly like clicking it in the menu.
        const target = document.querySelector(`.nova-v3-sidebar [data-menu-id="${CSS.escape(id)}"], .nova-v3-sheet [data-menu-id="${CSS.escape(id)}"]`);
        if (target) target.click();
        return;
      }
      const agentBtn = e.target.closest('[data-palette-agent]');
      if (agentBtn) {
        app.selectAgent(agentBtn.getAttribute('data-palette-agent'));
        close();
        return;
      }
      const convBtn = e.target.closest('[data-palette-conv]');
      if (convBtn) {
        app.openConversation(convBtn.getAttribute('data-palette-conv'));
        close();
        return;
      }
      const cmdBtn = e.target.closest('[data-palette-cmd]');
      if (cmdBtn) {
        const cmd = cmdBtn.getAttribute('data-palette-cmd');
        if (cmd === 'toggle-info') app.toggleInfoPane();
        close();
      }
    });

    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop || e.target.closest('[data-nova-action="close-palette"]')) {
        close();
      }
    });

    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (backdrop.classList.contains('is-hidden')) open();
        else close();
      } else if (e.key === 'Escape' && !backdrop.classList.contains('is-hidden')) {
        e.preventDefault();
        close();
      }
    });

    return { open, close };
  }

  window.initNovaPalette = initNovaPalette;
})();
