/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
/**
 * NovaAI App Shell & Rich Chat Controller (§3, §4, §11, §15.1–§15.3)
 */
(function () {
  const PERSONA_SUGGESTIONS = {
    nova: [
      'List files in my computer workspace',
      'Show live LLYVerse telemetry',
      'What is Lly Haven?',
      'Render a system status table and architecture diagram'
    ],
    astra: [
      'Explore Emergent Resonance Theory (ERT) equations in KaTeX',
      'Draft a harmonic narrative for AuraStream',
      'Synthesize creative directions for Lly Haven Sanctuary'
    ],
    astaria: [
      'Audit SQLite query latency and memory footprint',
      'Verify token cap math and formal invariants',
      'Compare consensus tradeoffs in a markdown table'
    ]
  };

  const state = {
    agents: [],
    sections: [],
    conversations: [],
    settings: { theme: 'dark', accent: 'cyan' },
    usage: null,
    novaPaused: false,
    activeAgentId: 'nova',
    activeConversationId: null,
    messages: [],
    pendingAttachments: [],
    drafts: {},
    activeThreadParentId: null,
    lightboxZoomed: false,
    workingJobId: null
  };

  function escapeHtml(str) {
    if (window.NovaRender && typeof window.NovaRender.escapeHtml === 'function') {
      return window.NovaRender.escapeHtml(str);
    }
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderRichMarkdown(text) {
    if (window.NovaRender && typeof window.NovaRender.renderMarkdown === 'function') {
      return window.NovaRender.renderMarkdown(text);
    }
    return escapeHtml(text).replace(/\n/g, '<br>');
  }

  function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  }

  function formatTimePT(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return '';
      return d.toLocaleTimeString('en-US', {
        timeZone: 'America/Los_Angeles',
        hour: 'numeric',
        minute: '2-digit'
      }) + ' PT';
    } catch (e) {
      return '';
    }
  }

  async function api(method, url, body = null, extraHeaders = {}) {
    const opts = {
      method,
      credentials: 'same-origin',
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...extraHeaders
      }
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function applyThemeAndAccent() {
    const root = document.documentElement;
    root.setAttribute('data-nova-theme', state.settings.theme || 'dark');
    root.setAttribute('data-nova-accent', state.settings.accent || 'cyan');
  }

  function updatePausedUI() {
    const banner = document.getElementById('novaPausedBanner');
    if (banner) {
      banner.classList.toggle('hidden', !state.novaPaused);
    }
  }

  function updateUnreadBadges() {
    const byAgent = { nova: 0, astra: 0, astaria: 0 };
    let total = 0;
    for (const c of state.conversations) {
      const count = Number(c.unreadCount) || 0;
      total += count;
      if (c.agentId && byAgent[c.agentId] !== undefined) {
        byAgent[c.agentId] += count;
      }
    }
    for (const [agentId, count] of Object.entries(byAgent)) {
      const badge = document.querySelector(`[data-agent-unread="${agentId}"]`);
      if (badge) {
        badge.textContent = String(count);
        badge.setAttribute('aria-label', `${count} unread`);
        badge.classList.toggle('hidden', count === 0);
      }
    }
    const totalEl = document.getElementById('novaTotalUnreadBadge');
    if (totalEl) {
      totalEl.textContent = `${total} unread`;
      totalEl.classList.toggle('hidden', total === 0);
    }
  }

  function renderSidebarConversations() {
    const convList = document.getElementById('novaConversationList');
    const roomList = document.getElementById('novaRoomList');
    if (!convList) return;

    const agentConvs = state.conversations.filter(c => c.type === 'direct' && c.agentId === state.activeAgentId);
    const rooms = state.conversations.filter(c => c.type === 'room');

    convList.innerHTML = agentConvs.map(c => {
      const active = c.id === state.activeConversationId;
      const unread = Number(c.unreadCount) || 0;
      return `
        <button
          type="button"
          data-conv-id="${escapeHtml(c.id)}"
          class="w-full text-left px-3 py-2 rounded-xl flex items-center justify-between gap-2 text-xs transition ${active ? 'bg-white/10 text-white font-semibold border border-white/15' : 'text-slate-300 hover:bg-white/5'}"
        >
          <span class="truncate">${escapeHtml(c.title)}</span>
          ${unread > 0 ? `<span class="nova-unread-badge" aria-label="${unread} unread">${unread}</span>` : ''}
        </button>
      `;
    }).join('');

    if (roomList) {
      roomList.innerHTML = rooms.map(r => {
        const active = r.id === state.activeConversationId;
        return `
          <button
            type="button"
            data-conv-id="${escapeHtml(r.id)}"
            class="w-full text-left px-3 py-2 rounded-xl flex items-center justify-between gap-2 text-xs transition ${active ? 'bg-white/10 text-white font-semibold border border-white/15' : 'text-slate-300 hover:bg-white/5'}"
          >
            <span class="truncate">🏛️ ${escapeHtml(r.title)}</span>
          </button>
        `;
      }).join('');
    }
  }

  function updateEmptyStateForPersona(agent) {
    const emptyState = document.getElementById('novaEmptyState');
    if (!emptyState) return;
    const h2 = emptyState.querySelector('h2');
    const p = emptyState.querySelector('p');
    const chipsWrap = emptyState.querySelector('.flex.flex-wrap');
    if (h2) h2.textContent = `${agent.name} Studio Ready`;
    if (p) p.textContent = agent.description || 'Ask a question, run a workspace check, or collaborate across your devices.';
    if (chipsWrap) {
      const list = PERSONA_SUGGESTIONS[agent.id] || PERSONA_SUGGESTIONS.nova;
      chipsWrap.innerHTML = list.map(prompt => `
        <button
          type="button"
          data-quick-prompt="${escapeHtml(prompt)}"
          class="px-3 py-1.5 rounded-full bg-white/5 hover:bg-white/10 border border-white/10 text-xs text-slate-200 transition"
        >
          ${escapeHtml(prompt)}
        </button>
      `).join('');
    }
  }

  function updateActivePersonaHeader() {
    const agent = state.agents.find(a => a.id === state.activeAgentId) || {
      id: 'nova',
      name: 'Nova',
      title: 'CEO & Executive Architect',
      description: 'Autonomous executive companion, systems architect, and LLYVerse orchestrator.'
    };

    document.querySelectorAll('.nova-agent-row').forEach(btn => {
      const isMatch = btn.getAttribute('data-agent-id') === agent.id;
      btn.classList.toggle('is-active', isMatch);
      btn.setAttribute('aria-current', isMatch ? 'page' : 'false');
    });

    const titleEl = document.getElementById('novaHeaderTitle');
    const roleEl = document.getElementById('novaHeaderRoleBadge');
    const dotEl = document.getElementById('novaHeaderDot');
    const compDot = document.querySelector('#novaComposerPersonaPill .nova-persona-dot');
    const compName = document.getElementById('novaComposerPersonaName');
    const input = document.getElementById('novaComposerInput');

    if (titleEl) titleEl.textContent = agent.name;
    if (roleEl) roleEl.textContent = agent.title || 'Persona';
    if (dotEl) dotEl.setAttribute('data-persona', agent.id);
    if (compDot) compDot.setAttribute('data-persona', agent.id);
    if (compName) compName.textContent = agent.name;
    if (input) input.placeholder = `Message ${agent.name}... (Enter to send, Shift+Enter for newline, / for commands)`;

    updateEmptyStateForPersona(agent);

    const infoDot = document.getElementById('novaInfoPersonaDot');
    const infoName = document.getElementById('novaInfoPersonaName');
    const infoTitle = document.getElementById('novaInfoPersonaTitle');
    const infoDesc = document.getElementById('novaInfoPersonaDesc');
    if (infoDot) infoDot.setAttribute('data-persona', agent.id);
    if (infoName) infoName.textContent = agent.name;
    if (infoTitle) infoTitle.textContent = agent.title || '';
    if (infoDesc) infoDesc.textContent = agent.description || '';

    const activeConv = state.conversations.find(c => c.id === state.activeConversationId);
    const roomMembersCard = document.getElementById('novaRoomMembersCard');
    const roomMembersList = document.getElementById('novaRoomMembersList');
    if (roomMembersCard && roomMembersList) {
      if (activeConv && activeConv.type === 'room') {
        roomMembersCard.classList.remove('hidden');
        const members = Array.isArray(activeConv.memberAgentIds) && activeConv.memberAgentIds.length > 0
          ? activeConv.memberAgentIds
          : ['nova', 'astra', 'astaria'];
        roomMembersList.innerHTML = members.map(m => `
          <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/5 border border-white/10 text-xs text-slate-200 capitalize">
            <span class="nova-persona-dot" data-persona="${escapeHtml(m)}"></span>
            <span>${escapeHtml(m)}</span>
          </span>
        `).join('');
      } else {
        roomMembersCard.classList.add('hidden');
      }
    }

    const pastChatsEl = document.getElementById('novaPastChatsList');
    if (pastChatsEl) {
      const past = state.conversations
        .filter(c => c.type === 'direct' && c.agentId === agent.id)
        .slice(0, 6);
      if (past.length === 0) {
        pastChatsEl.innerHTML = `<div class="text-slate-500">No past threads yet.</div>`;
      } else {
        pastChatsEl.innerHTML = past.map(c => `
          <button
            type="button"
            data-conv-id="${escapeHtml(c.id)}"
            class="w-full text-left px-2.5 py-1.5 rounded-lg flex items-center justify-between gap-2 ${c.id === state.activeConversationId ? 'bg-cyan-500/15 text-cyan-200 border border-cyan-500/30 font-semibold' : 'bg-black/30 hover:bg-white/5 text-slate-300 border border-white/5'} transition"
          >
            <span class="truncate">${escapeHtml(c.title)}</span>
            <span class="text-[10px] font-mono text-slate-500 shrink-0">${escapeHtml(formatTimePT(c.updatedAt || c.createdAt))}</span>
          </button>
        `).join('');
      }
    }
  }

  function renderAttachmentsBlock(attachments) {
    if (!Array.isArray(attachments) || attachments.length === 0) return '';
    const images = attachments.filter(a => String(a.mime || '').startsWith('image/'));
    const audios = attachments.filter(a => String(a.mime || '').startsWith('audio/'));
    const files = attachments.filter(a => !String(a.mime || '').startsWith('image/') && !String(a.mime || '').startsWith('audio/'));

    let html = '';

    // 1. Image Grid (§4.4: 1 large, or 2–4 tiles)
    if (images.length > 0) {
      const gridCols = images.length === 1 ? 'grid-cols-1 max-w-sm' : 'grid-cols-2 max-w-md';
      html += `<div class="nova-image-grid grid ${gridCols} gap-2 mt-2">`;
      for (const img of images) {
        const url = `/api/nova/attachments/${encodeURIComponent(img.id)}`;
        html += `
          <button
            type="button"
            data-lightbox-src="${escapeHtml(url)}"
            data-lightbox-name="${escapeHtml(img.name || 'Image')}"
            class="group relative overflow-hidden rounded-xl border border-white/15 bg-black/40 focus:outline-none focus:ring-2 focus:ring-cyan-400"
          >
            <img src="${escapeHtml(url)}" alt="${escapeHtml(img.name || 'Attachment')}" class="w-full h-40 object-cover group-hover:scale-105 transition-transform duration-200" loading="lazy" />
          </button>
        `;
      }
      html += `</div>`;
    }

    // 2. Voice Memos / Audio (§4.4: nova-voice-memo with play/pause, speed 1x/1.5x/2x, transcript)
    for (const aud of audios) {
      const url = `/api/nova/attachments/${encodeURIComponent(aud.id)}`;
      html += `
        <div class="nova-voice-memo mt-2 p-3 rounded-xl bg-black/40 border border-white/10 max-w-sm space-y-2" data-voice-memo-id="${escapeHtml(aud.id)}">
          <div class="flex items-center justify-between gap-2">
            <span class="text-[11px] font-mono text-cyan-300 truncate">🎙️ ${escapeHtml(aud.name || 'Voice memo')}</span>
            <button type="button" data-voice-speed="1" class="px-2 py-0.5 rounded bg-white/10 hover:bg-white/15 text-[10px] font-mono text-slate-200">1×</button>
          </div>
          <audio controls preload="metadata" src="${escapeHtml(url)}" class="w-full h-8"></audio>
          <details class="text-[11px] text-slate-400">
            <summary class="cursor-pointer hover:text-slate-200">Transcript</summary>
            <p class="mt-1 p-2 rounded bg-white/5 text-slate-300">${escapeHtml(aud.transcript || 'Transcript available on synthesis.')}</p>
          </details>
        </div>
      `;
    }

    // 3. File Cards (§4.4: type icon, name, size, Download + Preview for text/code)
    if (files.length > 0) {
      html += `<div class="flex flex-col gap-1.5 mt-2 max-w-md">`;
      for (const f of files) {
        const url = `/api/nova/attachments/${encodeURIComponent(f.id)}`;
        const isPreviewable = /^(text\/|application\/json|application\/javascript)/.test(f.mime || '') || /\.(txt|md|json|csv|js|ts|py|sh|log|html|css|sql|yaml|yml)$/i.test(f.name || '');
        html += `
          <div class="flex items-center justify-between gap-3 px-3 py-2 rounded-xl bg-black/40 border border-white/10 text-xs">
            <div class="min-w-0 flex-1">
              <div class="font-mono text-slate-200 truncate">${escapeHtml(f.name || 'file')}</div>
              <div class="text-[10px] text-slate-500">${escapeHtml(formatBytes(f.size))}</div>
            </div>
            <div class="flex items-center gap-1.5 shrink-0">
              ${isPreviewable ? `<button type="button" data-preview-file-url="${escapeHtml(url)}" data-preview-file-name="${escapeHtml(f.name || 'file')}" class="px-2 py-1 rounded-lg bg-white/5 hover:bg-white/10 text-cyan-300 text-[11px]">Preview</button>` : ''}
              <a href="${escapeHtml(url)}?download=1" download="${escapeHtml(f.name || 'file')}" class="px-2 py-1 rounded-lg bg-white/10 hover:bg-white/15 text-slate-200 text-[11px]">Download</a>
            </div>
          </div>
        `;
      }
      html += `</div>`;
    }

    return html;
  }

  function renderLinkPillsBlock(text) {
    if (!window.NovaRender || typeof window.NovaRender.extractLinkPills !== 'function') return '';
    const pills = window.NovaRender.extractLinkPills(text);
    if (!pills.length) return '';
    return `
      <div class="flex flex-wrap gap-1.5 mt-2">
        ${pills.map(p => `
          <a
            href="${escapeHtml(p.href)}"
            ${p.isInternal ? '' : 'target="_blank" rel="noopener noreferrer"'}
            class="nova-link-pill inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] bg-white/5 hover:bg-white/10 border ${p.isInternal ? 'border-cyan-400/50 text-cyan-200' : 'border-white/10 text-slate-300'} transition"
          >
            <span class="truncate max-w-[160px] font-medium">${escapeHtml(p.label)}</span>
            <span class="text-[10px] text-slate-500 font-mono">${escapeHtml(p.domain)}</span>
          </a>
        `).join('')}
      </div>
    `;
  }

  function renderReactionsChips(msg) {
    const list = Array.isArray(msg.reactions) ? msg.reactions : [];
    const grouped = new Map();
    for (const r of list) {
      const key = r.emoji;
      if (!grouped.has(key)) grouped.set(key, { emoji: key, count: 0, actors: [] });
      const item = grouped.get(key);
      item.count++;
      item.actors.push(`${r.actorType || r.actor_type}:${r.actorId || r.actor_id}`);
    }
    return Array.from(grouped.values()).map(g => `
      <button
        type="button"
        data-react-msg="${escapeHtml(msg.id)}"
        data-react-emoji="${escapeHtml(g.emoji)}"
        class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-cyan-500/15 border border-cyan-400/30 text-xs text-slate-100 hover:bg-cyan-500/25 transition"
        title="Reacted by ${escapeHtml(g.actors.join(', '))}"
      >
        <span>${escapeHtml(g.emoji)}</span>
        <span class="text-[10px] font-mono text-cyan-300">${g.count}</span>
      </button>
    `).join('');
  }

  function renderProgressGroupElement(progressMessages) {
    const details = document.createElement('details');
    details.className = 'nova-steps-group my-1 max-w-xl rounded-xl bg-white/[0.03] border border-white/10 px-3 py-2 text-xs text-slate-300';
    details.setAttribute('data-steps-group', 'true');
    const count = progressMessages.length;
    const lastStep = progressMessages[count - 1];

    const itemsHtml = progressMessages.map(pm => {
      const tool = pm.payload && pm.payload.tool ? pm.payload.tool : 'step';
      const ms = pm.payload && pm.payload.ms ? `${pm.payload.ms}ms` : '';
      const detail = pm.payload && pm.payload.detail ? pm.payload.detail : '';
      return `
        <div class="py-1 border-t border-white/5 flex flex-col gap-0.5" data-message-id="${escapeHtml(pm.id)}">
          <div class="flex items-center justify-between gap-2">
            <span class="inline-flex items-center gap-1.5 text-emerald-300">
              <span>✓</span>
              <span class="text-slate-200">${escapeHtml(pm.body || 'Completed step')}</span>
            </span>
            <span class="font-mono text-[10px] text-slate-500">${escapeHtml(tool)} ${escapeHtml(ms)}</span>
          </div>
          ${detail ? `<div class="text-[10px] font-mono text-slate-500 pl-4">${escapeHtml(detail)}</div>` : ''}
        </div>
      `;
    }).join('');

    details.innerHTML = `
      <summary class="cursor-pointer select-none flex items-center justify-between gap-3 font-medium text-slate-300 hover:text-white">
        <span class="inline-flex items-center gap-2">
          <span class="inline-flex items-center justify-center w-4 h-4 rounded-full bg-emerald-500/20 text-emerald-300 text-[10px]">✓</span>
          <span>Steps (${count})</span>
          <span class="text-slate-500 truncate max-w-xs">— ${escapeHtml(lastStep.body || '')}</span>
        </span>
        <span class="text-[10px] font-mono text-slate-500">Expand</span>
      </summary>
      <div class="mt-2 space-y-1">${itemsHtml}</div>
    `;
    return details;
  }

  function updateConnectorBadges(connectors) {
    if (!connectors || typeof connectors !== 'object') return;
    state.connectors = connectors;
    for (const [key, info] of Object.entries(connectors)) {
      const badge = document.querySelector(`[data-connector-badge="${key}"]`);
      if (badge) {
        if (info && info.connected) {
          badge.textContent = 'Connected';
          badge.className = 'text-[10px] font-mono text-emerald-400 font-semibold';
        } else {
          badge.textContent = key === 'elevenlabs' ? 'Key' : 'Connect';
          badge.className = 'text-[10px] font-mono text-slate-500';
        }
      }
    }
  }

  function renderMessageElement(msg, prevMsg = null) {
    const wrapper = document.createElement('div');
    wrapper.id = `nova-msg-${msg.id}`;
    wrapper.setAttribute('data-message-id', msg.id);

    if (msg.kind === 'notice') {
      wrapper.className = 'nova-bubble-notice';
      wrapper.textContent = msg.body || '';
      return wrapper;
    }

    if (window.NovaCards) {
      if (msg.kind === 'question') {
        wrapper.innerHTML = window.NovaCards.question(msg);
        return wrapper;
      }
      if (msg.kind === 'approval') {
        wrapper.innerHTML = window.NovaCards.approval(msg);
        return wrapper;
      }
      if (msg.kind === 'secure_form') {
        wrapper.innerHTML = window.NovaCards.secureForm(msg);
        return wrapper;
      }
      if (msg.kind === 'secure_form_result') {
        wrapper.innerHTML = window.NovaCards.secureFormResult(msg);
        return wrapper;
      }
    }

    const isUser = msg.role === 'user';
    wrapper.className = `group flex flex-col ${isUser ? 'items-end' : 'items-start'} gap-1`;

    // Group avatar header if sender changed or > 5 min elapsed (§4.2)
    let showHeader = !isUser && Boolean(msg.agentId);
    if (showHeader && prevMsg && prevMsg.role === msg.role && prevMsg.agentId === msg.agentId) {
      const t1 = new Date(prevMsg.createdAt || 0).getTime();
      const t2 = new Date(msg.createdAt || 0).getTime();
      if (Math.abs(t2 - t1) < 5 * 60 * 1000) {
        showHeader = false;
      }
    }

    const bubble = document.createElement('div');
    bubble.className = `nova-bubble ${isUser ? 'nova-bubble-user' : (msg.kind === 'error' ? 'nova-bubble-error' : 'nova-bubble-assistant')}`;

    if (showHeader) {
      const label = msg.agentId === 'astra' ? 'Astra' : msg.agentId === 'astaria' ? 'Astaria' : 'Nova';
      const header = document.createElement('div');
      header.className = 'flex items-center gap-1.5 text-[11px] font-bold mb-1 text-slate-300';
      header.innerHTML = `
        <span class="nova-persona-dot" data-persona="${escapeHtml(msg.agentId)}"></span>
        <span>${escapeHtml(label)}</span>
        <span class="text-[10px] font-normal text-slate-500 ml-1">${escapeHtml(formatTimePT(msg.createdAt))}</span>
      `;
      bubble.appendChild(header);
    }

    const bodyDiv = document.createElement('div');
    bodyDiv.className = 'nova-msg-body';
    bodyDiv.innerHTML = renderRichMarkdown(msg.body || (msg.status === 'streaming' ? '…' : ''));
    bubble.appendChild(bodyDiv);

    // Attachments & Voice Memos (§4.4)
    if (Array.isArray(msg.attachments) && msg.attachments.length > 0) {
      const attDiv = document.createElement('div');
      attDiv.innerHTML = renderAttachmentsBlock(msg.attachments);
      bubble.appendChild(attDiv);
    }

    // Link Pills (§4.5)
    if (msg.body) {
      const pillsHtml = renderLinkPillsBlock(msg.body);
      if (pillsHtml) {
        const pillsDiv = document.createElement('div');
        pillsDiv.className = 'nova-msg-pills';
        pillsDiv.innerHTML = pillsHtml;
        bubble.appendChild(pillsDiv);
      }
    }

    wrapper.appendChild(bubble);

    // Saved to memory · Undo inline notice chip (§7, §15.4)
    if (msg.payload && msg.payload.savedMemory && msg.payload.savedMemory.id) {
      const mem = msg.payload.savedMemory;
      const chip = document.createElement('div');
      chip.className = 'inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-[11px] text-emerald-300 font-medium';
      chip.setAttribute('data-saved-memory-chip', String(mem.id));
      chip.innerHTML = `
        <span>🧠 Saved to memory</span>
        <span class="text-slate-400">·</span>
        <button type="button" data-undo-memory="${escapeHtml(String(mem.id))}" class="underline hover:text-white font-semibold">Undo</button>
      `;
      wrapper.appendChild(chip);
    }

    // Meta bar: Reactions + Hover Tapback Bar + Thread Reply Link (§4.6, §4.8)
    const replyCount = Number(msg.replyCount) || 0;
    const metaBar = document.createElement('div');
    metaBar.className = 'flex flex-wrap items-center gap-2 px-1 text-[11px] text-slate-500';
    metaBar.innerHTML = `
      <span data-msg-reactions="${escapeHtml(msg.id)}" class="flex flex-wrap items-center gap-1">${renderReactionsChips(msg)}</span>
      <span class="opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity inline-flex items-center gap-0.5 bg-white/5 border border-white/10 rounded-full px-1.5 py-0.5">
        ${['❤️', '👍', '😂', '😮', '😢', '🙏'].map(em => `
          <button type="button" data-react-msg="${escapeHtml(msg.id)}" data-react-emoji="${em}" class="hover:scale-125 transition-transform px-1 text-xs" title="React ${em}" aria-label="React ${em}">${em}</button>
        `).join('')}
      </span>
      <button
        type="button"
        data-open-thread="${escapeHtml(msg.id)}"
        class="text-[11px] font-medium ${replyCount > 0 ? 'text-cyan-400 hover:text-cyan-300' : 'opacity-0 group-hover:opacity-100 text-slate-400 hover:text-slate-200'} transition"
      >
        ${replyCount > 0 ? `${replyCount} ${replyCount === 1 ? 'reply' : 'replies'} ›` : 'Reply in thread ›'}
      </button>
    `;
    wrapper.appendChild(metaBar);

    return wrapper;
  }

  function renderMessagesList() {
    const streamEl = document.getElementById('novaMessagesStream');
    const emptyState = document.getElementById('novaEmptyState');
    if (!streamEl) return;

    streamEl.querySelectorAll('[data-message-id], [data-steps-group]').forEach(el => el.remove());

    if (emptyState) {
      emptyState.classList.toggle('hidden', state.messages.length > 0);
    }

    let i = 0;
    let prevRendered = null;
    while (i < state.messages.length) {
      const msg = state.messages[i];
      // Group consecutive progress messages into one collapsible "Steps (N)" block (§4.7)
      if (msg.kind === 'progress') {
        const group = [msg];
        while (i + 1 < state.messages.length && state.messages[i + 1].kind === 'progress') {
          i++;
          group.push(state.messages[i]);
        }
        streamEl.appendChild(renderProgressGroupElement(group));
        i++;
        continue;
      }

      streamEl.appendChild(renderMessageElement(msg, prevRendered));
      prevRendered = msg;
      i++;
    }
    streamEl.scrollTop = streamEl.scrollHeight;
  }

  function renderPendingAttachments() {
    const strip = document.getElementById('novaPendingAttachments');
    if (!strip) return;
    if (state.pendingAttachments.length === 0) {
      strip.classList.add('hidden');
      strip.innerHTML = '';
      return;
    }
    strip.classList.remove('hidden');
    strip.innerHTML = state.pendingAttachments.map(att => `
      <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-cyan-500/15 border border-cyan-400/30 text-xs text-cyan-200 font-mono">
        <span class="truncate max-w-[160px]">${escapeHtml(att.name)}</span>
        <button type="button" data-remove-attachment="${escapeHtml(att.id)}" class="hover:text-white" aria-label="Remove attachment">×</button>
      </span>
    `).join('');
  }

  async function uploadFiles(fileList) {
    if (!fileList || fileList.length === 0) return;
    const formData = new FormData();
    Array.from(fileList).slice(0, 4).forEach(f => formData.append('files', f));
    try {
      const res = await fetch('/api/nova/uploads', {
        method: 'POST',
        credentials: 'same-origin',
        body: formData
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Upload failed');
      }
      const uploaded = data.attachments || (data.attachment ? [data.attachment] : []);
      state.pendingAttachments.push(...uploaded);
      renderPendingAttachments();
    } catch (err) {
      alert(err.message || 'Upload failed');
    }
  }

  async function openThread(parentId) {
    state.activeThreadParentId = parentId;
    const panel = document.getElementById('novaThreadPanel');
    const parentCard = document.getElementById('novaThreadParentCard');
    const repliesList = document.getElementById('novaThreadRepliesList');
    const countEl = document.getElementById('novaThreadReplyCount');
    if (!panel) return;

    panel.classList.remove('hidden');
    try {
      const data = await api('GET', `/api/nova/messages/${encodeURIComponent(parentId)}/thread`);
      if (parentCard && data.parent) {
        parentCard.innerHTML = renderRichMarkdown(data.parent.body || '');
      }
      const replies = data.replies || [];
      if (countEl) {
        countEl.textContent = `(${replies.length} ${replies.length === 1 ? 'reply' : 'replies'})`;
      }
      if (repliesList) {
        repliesList.innerHTML = replies.map(r => `
          <div class="p-2.5 rounded-xl ${r.role === 'user' ? 'bg-cyan-500/15 border border-cyan-500/30 ml-4' : 'bg-white/5 border border-white/10 mr-4'} text-xs">
            <div class="flex items-center justify-between text-[10px] text-slate-400 mb-1">
              <span class="font-bold text-slate-200">${escapeHtml(r.role === 'user' ? 'You' : (r.agentId || 'Nova'))}</span>
              <span>${escapeHtml(formatTimePT(r.createdAt))}</span>
            </div>
            <div class="nova-msg-body text-slate-100">${renderRichMarkdown(r.body || '')}</div>
          </div>
        `).join('');
      }
    } catch (e) {
      console.warn('[Nova Thread Error]', e);
    }
  }

  function closeThread() {
    state.activeThreadParentId = null;
    const panel = document.getElementById('novaThreadPanel');
    if (panel) panel.classList.add('hidden');
  }

  async function openConversation(conversationId) {
    const input = document.getElementById('novaComposerInput');
    if (input && state.activeConversationId) {
      state.drafts[state.activeConversationId] = input.value;
    }

    state.activeConversationId = conversationId;
    const conv = state.conversations.find(c => c.id === conversationId);
    if (conv && conv.type === 'direct' && conv.agentId) {
      state.activeAgentId = conv.agentId;
    }
    updateActivePersonaHeader();
    renderSidebarConversations();

    if (input) {
      input.value = state.drafts[conversationId] || '';
    }

    try {
      const data = await api('GET', `/api/nova/conversations/${encodeURIComponent(conversationId)}/messages?limit=50`);
      state.messages = data.messages || [];
      renderMessagesList();
      if (conv && conv.unreadCount > 0) {
        conv.unreadCount = 0;
        updateUnreadBadges();
        renderSidebarConversations();
        api('POST', `/api/nova/conversations/${encodeURIComponent(conversationId)}/read`, {}).catch(() => {});
      }
    } catch (e) {
      console.warn('[Nova] Failed to load conversation messages:', e);
    }
  }

  async function selectAgent(agentId) {
    state.activeAgentId = agentId;
    updateActivePersonaHeader();
    let conv = state.conversations.find(c => c.type === 'direct' && c.agentId === agentId);
    if (!conv) {
      const created = await api('POST', '/api/nova/conversations', { type: 'direct', agentId });
      conv = created.conversation;
      state.conversations.unshift(conv);
    }
    await openConversation(conv.id);
  }

  async function sendMessage(text, parentId = null) {
    const clean = String(text || '').trim();
    const attachmentIds = parentId ? [] : state.pendingAttachments.map(a => a.id);
    if (!clean && attachmentIds.length === 0) return;
    if (!state.activeConversationId) return;

    const capBanner = document.getElementById('novaCapBanner');
    if (capBanner) capBanner.classList.add('hidden');

    if (!parentId) {
      state.pendingAttachments = [];
      renderPendingAttachments();
      delete state.drafts[state.activeConversationId];
    }

    try {
      await api('POST', `/api/nova/conversations/${encodeURIComponent(state.activeConversationId)}/messages`, {
        text: clean,
        parentId,
        attachmentIds
      });
      if (parentId && state.activeThreadParentId === parentId) {
        setTimeout(() => openThread(parentId), 400);
      }
    } catch (err) {
      if (err.data && err.data.error && err.data.error.includes('Daily limit reached')) {
        if (capBanner) {
          document.getElementById('novaCapBannerText').textContent = err.data.error;
          capBanner.classList.remove('hidden');
        }
      } else {
        alert(err.message || 'Failed to send message');
      }
    }
  }

  function showModal(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('hidden', 'is-hidden');
  }

  function hideModal(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.add('hidden', 'is-hidden');
  }

  async function refreshMemories() {
    try {
      const searchEl = document.getElementById('novaMemorySearchInput');
      const scopeEl = document.getElementById('novaMemoryScopeFilter') || document.getElementById('novaMemoryAgentFilter');
      const q = searchEl ? searchEl.value.trim() : '';
      const rawScope = scopeEl ? scopeEl.value : '';
      const scope = (rawScope === 'all') ? '' : (rawScope === 'shared' ? 'global' : rawScope);
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (scope) params.set('scope', scope);

      const res = await api('GET', `/api/nova/memories?${params.toString()}`);
      state.memories = Array.isArray(res.memories) ? res.memories : [];

      const badge = document.getElementById('novaMemoryCountBadge');
      if (badge) badge.textContent = String(state.memories.length);
      const modalBadge = document.getElementById('novaMemoryModalCount');
      if (modalBadge) modalBadge.textContent = String(state.memories.length);

      const previewEl = document.getElementById('novaMemoryPreviewList');
      if (previewEl) {
        if (state.memories.length === 0) {
          previewEl.innerHTML = `<div class="text-slate-500">No memories stored yet. Say "remember that..." in chat.</div>`;
        } else {
          previewEl.innerHTML = state.memories.slice(0, 3).map(m => `
            <div class="p-2 rounded-lg bg-black/30 border border-white/5 flex items-center justify-between gap-2">
              <div class="truncate">
                <span class="font-mono text-cyan-300">${escapeHtml(m.key)}</span>:
                <span class="text-slate-200">${escapeHtml(m.value)}</span>
              </div>
              <span class="text-[10px] font-mono text-slate-500 uppercase shrink-0">${escapeHtml(m.scope)}</span>
            </div>
          `).join('');
        }
      }

      const modalList = document.getElementById('novaMemoryModalList') || document.getElementById('novaMemoryFullList');
      if (modalList) {
        if (state.memories.length === 0) {
          modalList.innerHTML = `<div class="text-xs text-slate-500 text-center py-6">No matching memories in your vault.</div>`;
        } else {
          modalList.innerHTML = state.memories.map(m => `
            <div class="p-3 rounded-xl bg-white/[0.03] border border-white/10 space-y-2" data-memory-row="${escapeHtml(String(m.id))}">
              <div class="flex items-center justify-between gap-2">
                <div class="flex items-center gap-2 min-w-0">
                  <span class="px-2 py-0.5 rounded bg-cyan-500/15 border border-cyan-500/30 text-[10px] font-mono text-cyan-300 uppercase">${escapeHtml(m.scope)}</span>
                  <span class="font-mono text-xs font-bold text-white truncate">${escapeHtml(m.key)}</span>
                </div>
                <div class="flex items-center gap-1.5 shrink-0">
                  <span class="text-[10px] font-mono text-slate-500">${escapeHtml(m.source || 'manual')}</span>
                  <button type="button" data-save-memory="${escapeHtml(String(m.id))}" class="px-2 py-1 rounded bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 text-[10px] font-semibold">Save</button>
                  <button type="button" data-delete-memory="${escapeHtml(String(m.id))}" class="px-2 py-1 rounded bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 text-[10px] font-semibold">Delete</button>
                </div>
              </div>
              <input
                type="text"
                data-memory-edit-input="${escapeHtml(String(m.id))}"
                value="${escapeHtml(m.value)}"
                class="w-full px-2.5 py-1.5 rounded-lg bg-black/50 border border-white/10 text-xs text-slate-100 focus:outline-none focus:border-cyan-400"
              />
            </div>
          `).join('');
        }
      }
    } catch (e) {}
  }

  async function refreshRoutines() {
    try {
      const res = await api('GET', '/api/nova/routines');
      state.routines = Array.isArray(res.routines) ? res.routines : [];
      const listEl = document.getElementById('novaRoutinesList');
      if (!listEl) return;
      if (state.routines.length === 0) {
        listEl.innerHTML = `<div class="text-slate-500">No routines configured yet.</div>`;
        return;
      }
      listEl.innerHTML = state.routines.map(r => `
        <div class="p-2 rounded-lg bg-black/30 border border-white/10 space-y-1">
          <div class="flex items-center justify-between gap-2">
            <span class="font-semibold text-white truncate">${escapeHtml(r.name)}</span>
            <span class="font-mono text-[10px] text-cyan-300">${escapeHtml(r.cron)} PT</span>
          </div>
          <div class="text-[10px] text-slate-400 truncate">${escapeHtml(r.prompt)}</div>
          <div class="flex items-center justify-between gap-2 pt-1">
            <span class="text-[10px] font-mono ${r.enabled ? 'text-emerald-400' : 'text-slate-500'}">${r.enabled ? 'Enabled' : 'Paused'} · ${escapeHtml(r.agentId)}</span>
            <div class="flex items-center gap-1">
              <button type="button" data-routine-run="${escapeHtml(r.id)}" class="px-1.5 py-0.5 rounded bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-200 text-[10px]">Run now</button>
              <button type="button" data-routine-toggle="${escapeHtml(r.id)}" data-routine-enabled="${r.enabled ? '1' : '0'}" class="px-1.5 py-0.5 rounded bg-white/10 hover:bg-white/15 text-slate-200 text-[10px]">${r.enabled ? 'Pause' : 'Enable'}</button>
              <button type="button" data-routine-delete="${escapeHtml(r.id)}" class="px-1.5 py-0.5 rounded bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 text-[10px]">×</button>
            </div>
          </div>
        </div>
      `).join('');
    } catch (e) {}
  }

  async function refreshComputerFiles() {
    const listEl = document.getElementById('novaComputerFilesList');
    if (!listEl) return;
    try {
      const res = await api('GET', '/api/nova/computer/files');
      const items = Array.isArray(res.items) ? res.items : [];
      if (items.length === 0) {
        listEl.innerHTML = `<div class="text-slate-500">Workspace is empty.</div>`;
        return;
      }
      listEl.innerHTML = items.map(item => `
        <div class="flex items-center justify-between gap-2 px-2 py-1 rounded bg-black/40 border border-white/5">
          <button
            type="button"
            data-computer-file-open="${escapeHtml(item.name)}"
            class="text-left font-mono text-slate-200 hover:text-cyan-300 truncate flex-1"
          >
            ${item.type === 'directory' ? '📁' : '📄'} ${escapeHtml(item.name)}
          </button>
          <span class="text-[10px] font-mono text-slate-500 shrink-0">${item.type === 'directory' ? 'dir' : escapeHtml(formatBytes(item.size))}</span>
        </div>
      `).join('');
    } catch (e) {}
  }

  function connectLiveScreen() {
    const imgEl = document.getElementById('novaLiveScreenImg');
    const badgeEl = document.getElementById('novaScreenStatusBadge') || document.getElementById('novaComputerFrameBadge');
    const overlayEl = document.getElementById('novaLiveScreenOverlay');
    const statusEl = document.getElementById('novaLiveScreenStatus');
    if (!imgEl) return;

    if (state.screenEventSource) {
      try { state.screenEventSource.close(); } catch (e) {}
      state.screenEventSource = null;
    }

    api('POST', '/api/nova/computer/screen/token', {}).then(({ token }) => {
      if (!token) return;
      const es = new EventSource(`/api/nova/computer/screen/stream?token=${encodeURIComponent(token)}`);
      state.screenEventSource = es;
      es.addEventListener('frame', (ev) => {
        try {
          const data = JSON.parse(ev.data);
          const uri = data.dataUri || data.frame;
          if (uri) {
            imgEl.src = uri;
            if (overlayEl) overlayEl.classList.add('hidden');
            if (statusEl) statusEl.textContent = 'LIVE • 2 FPS';
          }
          if (badgeEl) {
            badgeEl.textContent = 'LIVE • 2 FPS';
            badgeEl.className = 'px-1.5 py-0.5 rounded bg-emerald-500/20 border border-emerald-500/40 text-[9px] font-mono text-emerald-300';
          }
        } catch (err) {}
      });
      es.addEventListener('stopped', () => {
        if (badgeEl) {
          badgeEl.textContent = 'PAUSED';
          badgeEl.className = 'px-1.5 py-0.5 rounded bg-rose-500/20 border border-rose-500/40 text-[9px] font-mono text-rose-300';
        }
        if (statusEl) statusEl.textContent = 'Paused';
        es.close();
      });
      es.onerror = () => {
        if (badgeEl) {
          badgeEl.textContent = 'IDLE';
          badgeEl.className = 'px-1.5 py-0.5 rounded bg-black/70 border border-white/10 text-[9px] font-mono text-slate-400';
        }
      };
    }).catch(() => {});

    if (!state.computerEventsSource) {
      try {
        const ce = new EventSource('/api/nova/computer/events');
        state.computerEventsSource = ce;
        const onTerm = (ev) => {
          try {
            const d = JSON.parse(ev.data);
            const outEl = document.getElementById('novaComputerTerminalOutput');
            if (outEl) {
              outEl.textContent += `\n$ ${d.command}\n${d.output || ''}\n`;
              outEl.scrollTop = outEl.scrollHeight;
            }
          } catch (e) {}
        };
        ce.addEventListener('terminal', onTerm);
        ce.addEventListener('terminal_output', onTerm);
        ce.addEventListener('fs', () => refreshComputerFiles());
        ce.addEventListener('fs_change', () => refreshComputerFiles());
      } catch (e) {}
    }
  }

  async function refreshUsageAndActions() {
    try {
      const u = await api('GET', '/api/nova/usage');
      state.usage = u;
      const barsEl = document.getElementById('novaUsageBars');
      if (barsEl && u.personas) {
        barsEl.innerHTML = ['nova', 'astra', 'astaria'].map(p => {
          const item = u.personas[p] || { totalTokens: 0, costUsd: 0 };
          const cap = (item.limit && item.limit.daily_token_cap) || 150000;
          const pct = Math.min(100, Math.round((item.totalTokens / cap) * 100));
          return `
            <div class="space-y-1">
              <div class="flex justify-between text-[11px]">
                <span class="capitalize font-semibold text-white">${p}</span>
                <span>${item.totalTokens.toLocaleString()} / ${cap.toLocaleString()} tok (${pct}%)</span>
              </div>
              <div class="w-full h-1.5 rounded-full bg-black/50 overflow-hidden">
                <div class="h-full bg-cyan-400" style="width: ${pct}%;"></div>
              </div>
            </div>
          `;
        }).join('');
      }
    } catch (e) {}

    try {
      const personaFilter = document.getElementById('novaActivityPersonaFilter');
      const sourceFilter = document.getElementById('novaActivitySourceFilter');
      const params = new URLSearchParams({ limit: '10' });
      if (personaFilter && personaFilter.value) params.set('agentId', personaFilter.value);
      if (sourceFilter && sourceFilter.value) params.set('source', sourceFilter.value);

      const act = await api('GET', `/api/nova/actions?${params.toString()}`);
      const listEl = document.getElementById('novaActivityList');
      if (listEl) {
        const rows = Array.isArray(act.actions) ? act.actions : [];
        if (rows.length === 0) {
          listEl.innerHTML = `<div class="text-slate-500">No matching actions.</div>`;
        } else {
          listEl.innerHTML = rows.map(a => `
            <div class="flex items-center justify-between gap-2 py-1 border-b border-white/5">
              <div class="min-w-0 flex-1">
                <div class="truncate text-slate-200 font-mono text-[11px]">${escapeHtml(a.action)}</div>
                <div class="text-[10px] text-slate-500">${escapeHtml(a.agent_id || 'nova')} · ${escapeHtml(formatTimePT(a.created_at))}</div>
              </div>
              <span class="px-1.5 py-0.5 rounded bg-white/5 text-[10px] font-mono shrink-0">${escapeHtml(a.source)}</span>
            </div>
          `).join('');
        }
      }
    } catch (e) {}

    refreshMemories();
    refreshRoutines();
  }

  function toggleInfoPane() {
    const pane = document.getElementById('novaInfoPane');
    if (!pane) return;
    pane.classList.toggle('is-hidden');
    if (!pane.classList.contains('is-hidden')) {
      refreshUsageAndActions();
    }
  }

  function bindSSE() {
    if (!window.NovaStreamClient) return;
    const stream = new window.NovaStreamClient({
      'message.created': ({ conversationId, message }) => {
        if (!message) return;
        if (message.payload && message.payload.savedMemory) {
          refreshMemories();
        }
        if (message.parentId) {
          const parentMsg = state.messages.find(m => m.id === message.parentId);
          if (parentMsg) {
            parentMsg.replyCount = (Number(parentMsg.replyCount) || 0) + 1;
            renderMessagesList();
          }
          if (state.activeThreadParentId === message.parentId) {
            openThread(message.parentId);
          }
          return;
        }
        if (conversationId === state.activeConversationId) {
          if (!state.messages.some(m => m.id === message.id)) {
            state.messages.push(message);
            renderMessagesList();
          }
        } else if (message.role === 'assistant') {
          const conv = state.conversations.find(c => c.id === conversationId);
          if (conv) {
            conv.unreadCount = (Number(conv.unreadCount) || 0) + 1;
            updateUnreadBadges();
            renderSidebarConversations();
          }
        }
      },
      'message.delta': ({ conversationId, messageId, delta }) => {
        if (conversationId !== state.activeConversationId) return;
        const msg = state.messages.find(m => m.id === messageId);
        if (msg) {
          msg.body = (msg.body || '') + delta;
          const el = document.querySelector(`#nova-msg-${messageId} .nova-msg-body`);
          if (el) {
            el.innerHTML = renderRichMarkdown(msg.body);
            const streamEl = document.getElementById('novaMessagesStream');
            if (streamEl) streamEl.scrollTop = streamEl.scrollHeight;
          }
        }
      },
      'message.updated': ({ conversationId, messageId, body, status, kind, payload }) => {
        if (conversationId !== state.activeConversationId) return;
        const msg = state.messages.find(m => m.id === messageId);
        if (msg) {
          if (body !== undefined) msg.body = body;
          if (status !== undefined) msg.status = status;
          if (kind !== undefined) msg.kind = kind;
          if (payload !== undefined) msg.payload = payload;
          renderMessagesList();
        }
      },
      'widget.answered': ({ connectorServer }) => {
        if (connectorServer) {
          api('GET', '/api/nova/connectors').then(res => {
            if (res && res.connectors) updateConnectorBadges(res.connectors);
          }).catch(() => {});
        }
      },
      'reaction': ({ messageId, actorType, actorId, emoji, op }) => {
        const msg = state.messages.find(m => m.id === messageId);
        if (!msg) return;
        msg.reactions = Array.isArray(msg.reactions) ? msg.reactions : [];
        if (op === 'add') {
          const exists = msg.reactions.some(r => (r.actorType || r.actor_type) === actorType && String(r.actorId || r.actor_id) === String(actorId) && r.emoji === emoji);
          if (!exists) {
            msg.reactions.push({ message_id: messageId, actorType, actorId: String(actorId), emoji });
          }
        } else if (op === 'remove') {
          msg.reactions = msg.reactions.filter(r => !((r.actorType || r.actor_type) === actorType && String(r.actorId || r.actor_id) === String(actorId) && r.emoji === emoji));
        }
        const container = document.querySelector(`[data-msg-reactions="${messageId}"]`);
        if (container) {
          container.innerHTML = renderReactionsChips(msg);
        }
      },
      'job.status': ({ conversationId, state: jobState }) => {
        const statusEl = document.getElementById('novaHeaderStatus');
        const cancelBtn = document.getElementById('novaCancelJobBtn');
        const compStopBtn = document.getElementById('novaComposerStopBtn');
        const sendBtn = document.getElementById('novaSendBtn');
        if (conversationId === state.activeConversationId) {
          const isWorking = jobState === 'working';
          if (statusEl) {
            statusEl.textContent = isWorking ? 'Working…' : 'Idle • History synced across devices';
          }
          if (cancelBtn) cancelBtn.classList.toggle('hidden', !isWorking);
          if (compStopBtn) compStopBtn.classList.toggle('hidden', !isWorking);
          if (sendBtn) sendBtn.classList.toggle('hidden', isWorking);
        }
      },
      'unread': ({ conversationId, count }) => {
        const conv = state.conversations.find(c => c.id === conversationId);
        if (conv) {
          conv.unreadCount = count;
          updateUnreadBadges();
          renderSidebarConversations();
        }
      },
      'nova.stopped': () => {
        state.novaPaused = true;
        updatePausedUI();
      }
    });
    stream.connect();
  }

  async function init() {
    try {
      const initial = window.__NOVA_BOOTSTRAP__ || await api('GET', '/api/nova/bootstrap');
      state.agents = initial.agents || [];
      state.sections = initial.sections || [];
      state.conversations = initial.conversations || [];
      state.settings = initial.settings || state.settings;
      state.usage = initial.usage || null;
      state.novaPaused = Boolean(initial.novaPaused);
      if (initial.connectors) updateConnectorBadges(initial.connectors);

      applyThemeAndAccent();
      updatePausedUI();
      updateUnreadBadges();

      const firstConv = state.conversations.find(c => c.type === 'direct' && c.agentId === 'nova') || state.conversations[0];
      if (firstConv) {
        await openConversation(firstConv.id);
      } else {
        await selectAgent('nova');
      }

      bindSSE();
      refreshUsageAndActions();
      if (document.getElementById('novaComputerCard')) {
        connectLiveScreen();
        refreshComputerFiles();
      }

      if (window.initNovaPalette) {
        window.initNovaPalette({ state, selectAgent, openConversation, toggleInfoPane });
      }
    } catch (e) {
      console.error('[Nova Init Error]', e);
    }

    // Secure Form Submission (§5.2)
    document.addEventListener('submit', async (e) => {
      const sfForm = e.target.closest('form[data-nova-secure-form]');
      if (sfForm) {
        e.preventDefault();
        const formId = sfForm.getAttribute('data-nova-secure-form');
        const formData = new FormData(sfForm);
        const values = {};
        for (const [k, v] of formData.entries()) {
          values[k] = v;
        }
        try {
          const res = await api('POST', `/api/nova/secure-forms/${encodeURIComponent(formId)}/submit`, values);
          sfForm.reset();
          if (res.connectors) updateConnectorBadges(res.connectors);
        } catch (err) {
          alert(err.message || 'Failed to submit secure form');
        }
        return;
      }

      // Add Memory Form (§7)
      if (e.target.id === 'novaAddMemoryForm') {
        e.preventDefault();
        const kEl = document.getElementById('novaMemoryNewKey');
        const vEl = document.getElementById('novaMemoryNewValue') || document.getElementById('novaNewMemoryTextInput');
        const sEl = document.getElementById('novaMemoryNewScope') || document.getElementById('novaNewMemoryScopeSelect');
        if (!vEl || !vEl.value.trim()) return;
        const val = vEl.value.trim();
        const key = (kEl && kEl.value.trim()) ? kEl.value.trim() : val.split(/[:\-]/)[0].trim().slice(0, 48) || 'fact';
        const rawScope = sEl ? sEl.value : 'global';
        const scope = rawScope === 'shared' ? 'global' : rawScope;
        await api('POST', '/api/nova/memories', {
          key,
          value: val,
          scope
        });
        if (kEl) kEl.value = '';
        vEl.value = '';
        await refreshMemories();
        return;
      }

      // Add Routine Form (§9)
      if (e.target.id === 'novaNewRoutineForm') {
        e.preventDefault();
        const nameEl = document.getElementById('novaRoutineName') || e.target.elements.name;
        const cronEl = document.getElementById('novaRoutineCron') || e.target.elements.cron;
        const agentEl = document.getElementById('novaRoutineAgent') || e.target.elements.agentId;
        const promptEl = document.getElementById('novaRoutinePrompt') || e.target.elements.prompt;
        if (!nameEl || !cronEl || !promptEl) return;
        await api('POST', '/api/nova/routines', {
          name: nameEl.value.trim(),
          cron: cronEl.value.trim(),
          agentId: agentEl ? agentEl.value : (state.activeAgentId || 'nova'),
          prompt: promptEl.value.trim(),
          conversationId: state.activeConversationId
        });
        e.target.reset();
        e.target.classList.add('hidden');
        await refreshRoutines();
        return;
      }

      // Interactive Computer Terminal Form (§6.2)
      if (e.target.id === 'novaComputerTerminalForm') {
        e.preventDefault();
        const cmdInput = document.getElementById('novaComputerTerminalInput');
        const outEl = document.getElementById('novaComputerTerminalOutput');
        if (!cmdInput || !cmdInput.value.trim()) return;
        const command = cmdInput.value.trim();
        cmdInput.value = '';
        if (outEl) outEl.textContent += `\n$ ${command}\nRunning...`;
        try {
          const res = await api('POST', '/api/nova/computer/terminal', { command }, { 'X-Admin-Direct': '1' });
          if (outEl) {
            outEl.textContent = outEl.textContent.replace(/\nRunning\.\.\.$/, `\n${res.output || ''}\n`);
            outEl.scrollTop = outEl.scrollHeight;
          }
        } catch (err) {
          if (outEl) outEl.textContent += `\nError: ${err.message}\n`;
        }
        return;
      }

      // Per-Agent Settings Form (§8.2)
      if (e.target.id === 'novaAgentSettingsForm') {
        e.preventDefault();
        const idInput = document.getElementById('novaAgentSettingsId') || document.getElementById('novaAgentSettingId');
        const agentId = (idInput && idInput.value) || state.activeAgentId;
        const voiceEl = document.getElementById('novaAgentVoiceSelect') || document.getElementById('novaAgentSettingVoice');
        const instrEl = document.getElementById('novaAgentCustomInstructions') || document.getElementById('novaAgentSettingPrompt') || document.getElementById('novaAgentSettingDesc');
        const patch = {
          agentSettings: {
            [agentId]: {
              voiceName: voiceEl ? voiceEl.value : agentId,
              verbosity: document.getElementById('novaAgentVerbositySelect')?.value || 'balanced',
              reasoningDepth: document.getElementById('novaAgentDepthSelect')?.value || 'standard',
              dailyTokenCap: Number(document.getElementById('novaAgentTokenCapInput')?.value) || 150000,
              dailyImageCap: Number(document.getElementById('novaAgentImageCapInput')?.value) || 5,
              dailyAudioSecondsCap: Number(document.getElementById('novaAgentAudioCapInput')?.value) || 300,
              customInstructions: instrEl ? instrEl.value : ''
            }
          }
        };
        const res = await api('PATCH', '/api/nova/settings', patch);
        state.settings = res.settings || state.settings;
        hideModal('novaAgentSettingsModal');
        refreshUsageAndActions();
        return;
      }
    });

    // Activity & Memory Filter Changes
    document.addEventListener('change', (e) => {
      if (e.target.id === 'novaActivityPersonaFilter' || e.target.id === 'novaActivitySourceFilter') {
        refreshUsageAndActions();
      } else if (e.target.id === 'novaMemoryScopeFilter' || e.target.id === 'novaMemoryAgentFilter') {
        refreshMemories();
      } else if (e.target.id === 'novaSettingTheme') {
        const theme = e.target.value;
        state.settings.theme = theme;
        applyThemeAndAccent();
        api('PATCH', '/api/nova/settings', { theme }).catch(() => {});
      } else if (e.target.id === 'novaSettingAccent') {
        const accent = e.target.value;
        state.settings.accent = accent;
        applyThemeAndAccent();
        api('PATCH', '/api/nova/settings', { accent }).catch(() => {});
      } else if (
        e.target.id === 'novaSettingDensity' ||
        e.target.id === 'novaSettingTimezone' ||
        e.target.id === 'novaSettingUpdateChannel' ||
        e.target.id === 'novaSettingChannel'
      ) {
        const patch = {
          density: document.getElementById('novaSettingDensity')?.value || 'comfortable',
          timezone: document.getElementById('novaSettingTimezone')?.value || 'America/Los_Angeles',
          updateChannel: (document.getElementById('novaSettingUpdateChannel') || document.getElementById('novaSettingChannel'))?.value || 'stable'
        };
        api('PATCH', '/api/nova/settings', patch).then(res => {
          state.settings = res.settings || state.settings;
        }).catch(() => {});
      }
    });

    document.addEventListener('input', (e) => {
      if (e.target.id === 'novaMemorySearchInput') {
        refreshMemories();
      }
    });

    // Event Delegation
    document.addEventListener('click', async (e) => {
      // Backdrop click closes modal (§10)
      if (e.target.classList && (e.target.classList.contains('nova-command-backdrop') || e.target.classList.contains('nova-palette-backdrop'))) {
        e.target.classList.add('hidden', 'is-hidden');
        return;
      }

      // Undo Saved Memory Chip (§7, §15.4)
      const undoMemBtn = e.target.closest('[data-undo-memory]');
      if (undoMemBtn) {
        const memId = undoMemBtn.getAttribute('data-undo-memory');
        await api('DELETE', `/api/nova/memories/${encodeURIComponent(memId)}`);
        const chip = undoMemBtn.closest('[data-saved-memory-chip]');
        if (chip) chip.remove();
        refreshMemories();
        return;
      }

      // Memory Vault Save / Delete (§7, §15.4)
      const saveMemBtn = e.target.closest('[data-save-memory]');
      if (saveMemBtn) {
        const memId = saveMemBtn.getAttribute('data-save-memory');
        const inputEl = document.querySelector(`[data-memory-edit-input="${memId}"]`);
        if (inputEl) {
          await api('PATCH', `/api/nova/memories/${encodeURIComponent(memId)}`, { value: inputEl.value.trim() });
          saveMemBtn.textContent = 'Saved ✓';
          setTimeout(() => { saveMemBtn.textContent = 'Save'; }, 1200);
          refreshMemories();
        }
        return;
      }

      const delMemBtn = e.target.closest('[data-delete-memory]');
      if (delMemBtn) {
        const memId = delMemBtn.getAttribute('data-delete-memory');
        await api('DELETE', `/api/nova/memories/${encodeURIComponent(memId)}`);
        refreshMemories();
        return;
      }

      // Routine Actions (§9)
      const runRoutineBtn = e.target.closest('[data-routine-run]');
      if (runRoutineBtn) {
        const id = runRoutineBtn.getAttribute('data-routine-run');
        await api('POST', `/api/nova/routines/${encodeURIComponent(id)}/run`, {
          conversationId: state.activeConversationId
        });
        refreshRoutines();
        refreshUsageAndActions();
        return;
      }

      const toggleRoutineBtn = e.target.closest('[data-routine-toggle]');
      if (toggleRoutineBtn) {
        const id = toggleRoutineBtn.getAttribute('data-routine-toggle');
        const enabled = toggleRoutineBtn.getAttribute('data-routine-enabled') !== '1';
        await api('PATCH', `/api/nova/routines/${encodeURIComponent(id)}`, { enabled });
        refreshRoutines();
        return;
      }

      const delRoutineBtn = e.target.closest('[data-routine-delete]');
      if (delRoutineBtn) {
        const id = delRoutineBtn.getAttribute('data-routine-delete');
        await api('DELETE', `/api/nova/routines/${encodeURIComponent(id)}`);
        refreshRoutines();
        return;
      }

      // Computer Tabs (§6.2)
      const compTabBtn = e.target.closest('[data-computer-tab]');
      if (compTabBtn) {
        const tab = compTabBtn.getAttribute('data-computer-tab');
        document.querySelectorAll('[data-computer-tab]').forEach(b => {
          const active = b.getAttribute('data-computer-tab') === tab;
          b.className = active
            ? 'px-2.5 py-1 rounded-lg bg-cyan-500/20 text-cyan-200 border border-cyan-500/30 font-medium'
            : 'px-2.5 py-1 rounded-lg bg-white/5 text-slate-400 hover:text-white';
        });
        document.querySelectorAll('[data-computer-panel]').forEach(p => {
          p.classList.toggle('hidden', p.getAttribute('data-computer-panel') !== tab);
        });
        if (tab === 'files') refreshComputerFiles();
        return;
      }

      // Open Computer File Preview (§6.2)
      const openCompFile = e.target.closest('[data-computer-file-open]');
      if (openCompFile) {
        const filePath = openCompFile.getAttribute('data-computer-file-open');
        const previewEl = document.getElementById('novaComputerFilePreview');
        if (previewEl) {
          try {
            const res = await api('GET', `/api/nova/computer/file?path=${encodeURIComponent(filePath)}`);
            previewEl.textContent = res.content || '(empty file)';
            previewEl.classList.remove('hidden');
          } catch (err) {
            previewEl.textContent = `Cannot preview: ${err.message}`;
            previewEl.classList.remove('hidden');
          }
        }
        return;
      }

      // Global Settings Theme & Accent Buttons (§8.1)
      const themeBtn = e.target.closest('[data-setting-theme]');
      if (themeBtn) {
        const theme = themeBtn.getAttribute('data-setting-theme');
        state.settings.theme = theme;
        applyThemeAndAccent();
        await api('PATCH', '/api/nova/settings', { theme });
        return;
      }

      const accentBtn = e.target.closest('[data-setting-accent]');
      if (accentBtn) {
        const accent = accentBtn.getAttribute('data-setting-accent');
        state.settings.accent = accent;
        applyThemeAndAccent();
        await api('PATCH', '/api/nova/settings', { accent });
        return;
      }

      // Question Card Option Click (§5.1)
      const qOptBtn = e.target.closest('[data-card-q-option]');
      if (qOptBtn) {
        const widgetId = qOptBtn.getAttribute('data-card-widget-id');
        const optId = qOptBtn.getAttribute('data-card-q-option');
        const isMulti = qOptBtn.getAttribute('data-card-multi') === '1';
        if (isMulti) {
          qOptBtn.classList.toggle('ring-2');
          qOptBtn.classList.toggle('ring-cyan-400');
          qOptBtn.setAttribute('data-selected', qOptBtn.getAttribute('data-selected') === '1' ? '0' : '1');
        } else {
          await api('POST', `/api/nova/widgets/${encodeURIComponent(widgetId)}/answer`, {
            selected: [optId],
            custom: null
          });
        }
        return;
      }

      // Question Card Submit (multi-select or custom answer) (§5.1)
      const qSubBtn = e.target.closest('[data-card-q-submit]');
      if (qSubBtn) {
        const widgetId = qSubBtn.getAttribute('data-card-q-submit');
        const card = qSubBtn.closest('[data-widget-id]');
        const selectedBtns = card ? Array.from(card.querySelectorAll('[data-card-q-option][data-selected="1"]')) : [];
        const selected = selectedBtns.map(b => b.getAttribute('data-card-q-option'));
        const customInput = card ? card.querySelector(`[data-card-q-custom="${widgetId}"]`) : null;
        const customVal = customInput && customInput.value.trim() ? customInput.value.trim() : null;
        await api('POST', `/api/nova/widgets/${encodeURIComponent(widgetId)}/answer`, {
          selected,
          custom: customVal
        });
        return;
      }

      // Approval Card Confirm (with two-click confirm for danger actions) (§5.3, §15.1)
      const appConfirmBtn = e.target.closest('[data-card-approval-confirm]');
      if (appConfirmBtn) {
        const widgetId = appConfirmBtn.getAttribute('data-card-approval-confirm');
        const needsDouble = appConfirmBtn.getAttribute('data-double-confirm') === '1';
        const armed = appConfirmBtn.getAttribute('data-armed') === '1';
        if (needsDouble && !armed) {
          appConfirmBtn.setAttribute('data-armed', '1');
          appConfirmBtn.textContent = 'Click again to confirm';
          setTimeout(() => {
            if (appConfirmBtn.isConnected) {
              appConfirmBtn.setAttribute('data-armed', '0');
              appConfirmBtn.textContent = appConfirmBtn.getAttribute('data-orig-label') || 'Confirm';
            }
          }, 4000);
          return;
        }
        await api('POST', `/api/nova/widgets/${encodeURIComponent(widgetId)}/answer`, {
          selected: ['confirm']
        });
        return;
      }

      // Approval Card Cancel (§5.3)
      const appCancelBtn = e.target.closest('[data-card-approval-cancel]');
      if (appCancelBtn) {
        const widgetId = appCancelBtn.getAttribute('data-card-approval-cancel');
        await api('POST', `/api/nova/widgets/${encodeURIComponent(widgetId)}/answer`, {
          selected: ['cancel']
        });
        return;
      }

      // Secure Form Password Show/Hide Toggle (§5.2)
      const pwdToggle = e.target.closest('[data-toggle-pwd]');
      if (pwdToggle) {
        const inputId = pwdToggle.getAttribute('data-toggle-pwd');
        const field = document.getElementById(inputId);
        if (field) {
          const isPwd = field.type === 'password';
          field.type = isPwd ? 'text' : 'password';
          pwdToggle.textContent = isPwd ? 'Hide' : 'Show';
        }
        return;
      }

      // Secure Form Cancel (§5.2)
      const sfCancelBtn = e.target.closest('[data-card-sf-cancel]');
      if (sfCancelBtn) {
        const formId = sfCancelBtn.getAttribute('data-card-sf-cancel');
        await api('POST', `/api/nova/secure-forms/${encodeURIComponent(formId)}/submit`, { _cancel: true });
        return;
      }

      // Launch Connector / ElevenLabs Secure Form Card in Chat (§5.2)
      const openSfBtn = e.target.closest('[data-open-secure-form]');
      if (openSfBtn && state.activeConversationId) {
        const kind = openSfBtn.getAttribute('data-open-secure-form');
        const isEleven = kind === 'elevenlabs';
        const spec = isEleven
          ? {
              title: 'Connect ElevenLabs Voice Key',
              target: { type: 'voice:elevenlabs', label: 'ElevenLabs Voice Synthesis' },
              fields: [
                { name: 'apiKey', label: 'ElevenLabs API Key', type: 'password', required: true, autocomplete: 'off' }
              ],
              submitLabel: 'Save Voice Key'
            }
          : {
              title: `Connect ${kind.charAt(0).toUpperCase() + kind.slice(1)}`,
              target: { type: 'mcp_credentials', server: kind, label: `${kind.charAt(0).toUpperCase() + kind.slice(1)} connector` },
              fields: [
                { name: 'email', label: 'Account Email', type: 'email', required: false, autocomplete: 'username' },
                { name: 'token', label: 'Integration Token / App Password', type: 'password', required: true, autocomplete: 'off' }
              ],
              submitLabel: 'Connect'
            };
        await api('POST', '/api/nova/cards', {
          conversationId: state.activeConversationId,
          agentId: 'nova',
          type: 'secure_form',
          spec
        });
        return;
      }

      // Copy Code Button (§4.3)
      const copyBtn = e.target.closest('[data-copy-code]');
      if (copyBtn) {
        const block = copyBtn.closest('.nova-code-block');
        const codeEl = block && block.querySelector('code');
        if (codeEl && navigator.clipboard) {
          await navigator.clipboard.writeText(codeEl.textContent || '');
          const orig = copyBtn.textContent;
          copyBtn.textContent = 'Copied!';
          setTimeout(() => { copyBtn.textContent = orig; }, 1400);
        }
        return;
      }

      // Image Lightbox (§4.4)
      const lbTrigger = e.target.closest('[data-lightbox-src]');
      if (lbTrigger) {
        const lb = document.getElementById('novaMediaLightbox');
        const img = document.getElementById('novaLightboxImg');
        const cap = document.getElementById('novaLightboxCaption');
        const dl = document.getElementById('novaLightboxDownload');
        const src = lbTrigger.getAttribute('data-lightbox-src');
        const name = lbTrigger.getAttribute('data-lightbox-name') || 'Image';
        if (lb && img) {
          img.src = src;
          img.alt = name;
          img.style.transform = 'scale(1)';
          state.lightboxZoomed = false;
          if (cap) cap.textContent = name;
          if (dl) dl.href = `${src}?download=1`;
          lb.classList.remove('hidden');
        }
        return;
      }

      // File Preview Sheet (§4.4)
      const previewBtn = e.target.closest('[data-preview-file-url]');
      if (previewBtn) {
        const url = previewBtn.getAttribute('data-preview-file-url');
        const name = previewBtn.getAttribute('data-preview-file-name') || 'file.txt';
        const sheet = document.getElementById('novaFilePreviewSheet');
        const titleEl = document.getElementById('novaFilePreviewTitle');
        const contentEl = document.getElementById('novaFilePreviewContent');
        const dlEl = document.getElementById('novaFilePreviewDownload');
        if (sheet && contentEl) {
          if (titleEl) titleEl.textContent = name;
          if (dlEl) dlEl.href = `${url}?download=1`;
          contentEl.textContent = 'Loading preview…';
          sheet.classList.remove('hidden');
          try {
            const res = await fetch(url, { credentials: 'same-origin' });
            const text = await res.text();
            contentEl.textContent = text.slice(0, 100000);
          } catch (err) {
            contentEl.textContent = 'Failed to load file preview.';
          }
        }
        return;
      }

      // Voice Memo Playback Speed (§4.4)
      const speedBtn = e.target.closest('[data-voice-speed]');
      if (speedBtn) {
        const wrap = speedBtn.closest('.nova-voice-memo');
        const audio = wrap && wrap.querySelector('audio');
        const speeds = [1, 1.5, 2];
        const cur = Number(speedBtn.getAttribute('data-voice-speed')) || 1;
        const next = speeds[(speeds.indexOf(cur) + 1) % speeds.length];
        speedBtn.setAttribute('data-voice-speed', String(next));
        speedBtn.textContent = `${next}×`;
        if (audio) audio.playbackRate = next;
        return;
      }

      // Remove Pending Attachment
      const rmAtt = e.target.closest('[data-remove-attachment]');
      if (rmAtt) {
        const id = rmAtt.getAttribute('data-remove-attachment');
        state.pendingAttachments = state.pendingAttachments.filter(a => a.id !== id);
        renderPendingAttachments();
        return;
      }

      // Open Thread (§4.8)
      const threadTrigger = e.target.closest('[data-open-thread]');
      if (threadTrigger) {
        openThread(threadTrigger.getAttribute('data-open-thread'));
        return;
      }

      // Slash Command Prompt (§4.9)
      const slashBtn = e.target.closest('[data-slash-prompt]');
      if (slashBtn) {
        const prompt = slashBtn.getAttribute('data-slash-prompt');
        const menu = document.getElementById('novaSlashMenu');
        const input = document.getElementById('novaComposerInput');
        if (menu) menu.classList.add('hidden');
        if (input) input.value = '';
        sendMessage(prompt);
        return;
      }

      const agentBtn = e.target.closest('.nova-agent-row[data-agent-id]');
      if (agentBtn) {
        selectAgent(agentBtn.getAttribute('data-agent-id'));
        return;
      }

      const convBtn = e.target.closest('[data-conv-id]');
      if (convBtn) {
        openConversation(convBtn.getAttribute('data-conv-id'));
        return;
      }

      const quickChip = e.target.closest('[data-quick-prompt]');
      if (quickChip) {
        sendMessage(quickChip.getAttribute('data-quick-prompt'));
        return;
      }

      const reactBtn = e.target.closest('[data-react-msg]');
      if (reactBtn) {
        const msgId = reactBtn.getAttribute('data-react-msg');
        const emoji = reactBtn.getAttribute('data-react-emoji') || '👍';
        await api('POST', `/api/nova/messages/${encodeURIComponent(msgId)}/reactions`, { emoji });
        return;
      }

      const actionEl = e.target.closest('[data-nova-action]');
      if (!actionEl) return;
      const action = actionEl.getAttribute('data-nova-action');

      if (action === 'stop-nova') {
        await api('POST', '/api/nova/stop', { reason: 'Stopped from Nova Studio header' });
        state.novaPaused = true;
        updatePausedUI();
      } else if (action === 'resume-nova') {
        const mint = await api('POST', '/api/nova/approvals/mint', {
          actionType: 'nova.resume',
          args: {}
        });
        await api('POST', '/api/nova/resume', {}, { 'X-Nova-Approval-Token': mint.token });
        state.novaPaused = false;
        updatePausedUI();
      } else if (action === 'toggle-info-pane') {
        toggleInfoPane();
      } else if (action === 'open-memory-modal' || action === 'open-memory-view') {
        hideModal('novaSettingsModal');
        showModal('novaMemoryModal');
        refreshMemories();
      } else if (action === 'close-memory-modal' || action === 'close-memory-view') {
        hideModal('novaMemoryModal');
      } else if (action === 'forget-all-memories') {
        const armed = actionEl.getAttribute('data-armed') === '1';
        if (!armed) {
          actionEl.setAttribute('data-armed', '1');
          actionEl.textContent = 'Click again to wipe all memories';
          setTimeout(() => {
            if (actionEl.isConnected) {
              actionEl.setAttribute('data-armed', '0');
              actionEl.textContent = actionEl.getAttribute('data-orig-label') || 'Forget everything';
            }
          }, 4000);
          return;
        }
        actionEl.setAttribute('data-armed', '0');
        actionEl.textContent = actionEl.getAttribute('data-orig-label') || 'Forget everything';
        const mint = await api('POST', '/api/nova/approvals/mint', {
          actionType: 'memory.forget_all',
          args: {}
        });
        await api('POST', '/api/nova/memories/forget-all', {}, { 'X-Nova-Approval-Token': mint.token });
        await refreshMemories();
      } else if (action === 'open-settings-modal' || action === 'open-settings') {
        showModal('novaSettingsModal');
      } else if (action === 'close-settings-modal' || action === 'close-settings') {
        hideModal('novaSettingsModal');
      } else if (action === 'open-agent-settings') {
        const agent = state.agents.find(a => a.id === state.activeAgentId) || { id: 'nova', name: 'Nova', description: '' };
        const titleEl = document.getElementById('novaAgentSettingsTitle');
        if (titleEl) titleEl.textContent = `${agent.name} Settings`;
        const idEl = document.getElementById('novaAgentSettingsId') || document.getElementById('novaAgentSettingId');
        if (idEl) idEl.value = agent.id;
        const nameEl = document.getElementById('novaAgentSettingName');
        if (nameEl) nameEl.value = agent.name;
        const descEl = document.getElementById('novaAgentSettingDesc');
        if (descEl) descEl.value = agent.description || '';
        showModal('novaAgentSettingsModal');
      } else if (action === 'close-agent-settings') {
        hideModal('novaAgentSettingsModal');
      } else if (action === 'voice-preview') {
        if ('speechSynthesis' in window) {
          const u = new SpeechSynthesisUtterance(`Hello from ${state.activeAgentId} in LLYVerse Studio.`);
          window.speechSynthesis.speak(u);
        }
      } else if (action === 'import-local-storage') {
        const statusEl = document.getElementById('novaImportLocalStatus');
        const payload = { conversations: [], memories: [] };
        try {
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && /nova|chat|history/i.test(k)) {
              const raw = localStorage.getItem(k);
              try {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) {
                  payload.conversations.push({ title: `Imported (${k})`, agentId: 'nova', messages: parsed });
                }
              } catch (e) {}
            }
          }
          const res = await api('POST', '/api/nova/import-local', payload);
          if (statusEl) {
            statusEl.textContent = `Imported ${res.importedConversations || 0} conversations & ${res.importedMemories || 0} memories.`;
            statusEl.classList.remove('hidden');
          }
          refreshMemories();
        } catch (err) {
          if (statusEl) {
            statusEl.textContent = `Import error: ${err.message}`;
            statusEl.classList.remove('hidden');
          }
        }
      } else if (action === 'toggle-new-routine') {
        const f = document.getElementById('novaNewRoutineForm');
        if (f) f.classList.toggle('hidden');
      } else if (action === 'reconnect-screen') {
        connectLiveScreen();
      } else if (action === 'open-test-window') {
        await api('POST', '/api/nova/computer/screen/window', {
          title: `Workspace Inspector (${new Date().toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles' })})`,
          lines: [
            'DISPLAY=:99 Xvfb Virtual Framebuffer Active',
            'Fluxbox window manager + workspace watcher synced',
            'Ready for Nova computer actions'
          ]
        });
      } else if (action === 'refresh-computer-files') {
        refreshComputerFiles();
      } else if (action === 'reset-computer') {
        const armed = actionEl.getAttribute('data-armed') === '1';
        if (!armed) {
          actionEl.setAttribute('data-armed', '1');
          actionEl.textContent = 'Confirm Reset';
          setTimeout(() => {
            if (actionEl.isConnected) {
              actionEl.setAttribute('data-armed', '0');
              actionEl.textContent = actionEl.getAttribute('data-orig-label') || 'Reset';
            }
          }, 4000);
          return;
        }
        actionEl.setAttribute('data-armed', '0');
        actionEl.textContent = actionEl.getAttribute('data-orig-label') || 'Reset';
        const mint = await api('POST', '/api/nova/approvals/mint', {
          actionType: 'nova_computer.reset',
          args: {}
        });
        await api('POST', '/api/nova/computer/reset', {}, { 'X-Nova-Approval-Token': mint.token });
        refreshComputerFiles();
        refreshUsageAndActions();
      } else if (action === 'close-thread') {
        closeThread();
      } else if (action === 'close-lightbox') {
        const lb = document.getElementById('novaMediaLightbox');
        if (lb) lb.classList.add('hidden');
      } else if (action === 'lightbox-zoom') {
        const img = document.getElementById('novaLightboxImg');
        if (img) {
          state.lightboxZoomed = !state.lightboxZoomed;
          img.style.transform = state.lightboxZoomed ? 'scale(1.65)' : 'scale(1)';
        }
      } else if (action === 'close-file-preview') {
        const sheet = document.getElementById('novaFilePreviewSheet');
        if (sheet) sheet.classList.add('hidden');
      } else if (action === 'trigger-upload') {
        const fileInput = document.getElementById('novaFileInput');
        if (fileInput) fileInput.click();
      } else if (action === 'toggle-voice-input') {
        const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRec) {
          alert('Speech recognition is not supported in this browser.');
          return;
        }
        const rec = new SpeechRec();
        rec.lang = 'en-US';
        rec.interimResults = false;
        rec.onresult = (ev) => {
          const transcript = ev.results && ev.results[0] && ev.results[0][0] ? ev.results[0][0].transcript : '';
          const input = document.getElementById('novaComposerInput');
          if (input && transcript) {
            input.value = (input.value ? input.value + ' ' : '') + transcript;
            input.focus();
          }
        };
        rec.start();
      } else if (action === 'toggle-mobile-sidebar' || action === 'mobile-back-to-list') {
        const sb = document.getElementById('novaSidebar');
        if (sb) sb.classList.toggle('is-mobile-open');
      } else if (action === 'new-chat' || action === 'new-direct-chat') {
        const res = await api('POST', '/api/nova/conversations', {
          type: 'direct',
          agentId: state.activeAgentId,
          title: `New ${state.activeAgentId.toUpperCase()} Thread`
        });
        state.conversations.unshift(res.conversation);
        await openConversation(res.conversation.id);
      } else if (action === 'create-council-room') {
        const res = await api('POST', '/api/nova/conversations', {
          type: 'room',
          title: 'Pantheon Council Room',
          memberAgentIds: ['nova', 'astra', 'astaria']
        });
        state.conversations.unshift(res.conversation);
        await openConversation(res.conversation.id);
      } else if (action === 'cancel-job') {
        if (state.activeConversationId) {
          await api('POST', `/api/nova/conversations/${encodeURIComponent(state.activeConversationId)}/cancel`, {});
        }
      } else if (action === 'refresh-actions') {
        refreshUsageAndActions();
      }
    });

    // File Input & Drag-and-Drop / Paste Uploads (§4.4)
    const fileInput = document.getElementById('novaFileInput');
    if (fileInput) {
      fileInput.addEventListener('change', () => {
        if (fileInput.files && fileInput.files.length > 0) {
          uploadFiles(fileInput.files);
          fileInput.value = '';
        }
      });
    }

    const chatStream = document.getElementById('novaMessagesStream');
    if (chatStream) {
      chatStream.addEventListener('dragover', (e) => {
        e.preventDefault();
      });
      chatStream.addEventListener('drop', (e) => {
        e.preventDefault();
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          uploadFiles(e.dataTransfer.files);
        }
      });
    }

    // Thread Form Submit (§4.8)
    const threadForm = document.getElementById('novaThreadForm');
    const threadInput = document.getElementById('novaThreadInput');
    if (threadForm && threadInput) {
      threadForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const text = threadInput.value.trim();
        if (!text || !state.activeThreadParentId) return;
        threadInput.value = '';
        sendMessage(text, state.activeThreadParentId);
      });
    }

    const form = document.getElementById('novaComposerForm');
    const input = document.getElementById('novaComposerInput');
    const slashMenu = document.getElementById('novaSlashMenu');
    if (form && input) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text && state.pendingAttachments.length === 0) return;
        input.value = '';
        if (slashMenu) slashMenu.classList.add('hidden');
        sendMessage(text);
      });
      input.addEventListener('input', () => {
        if (state.activeConversationId) {
          state.drafts[state.activeConversationId] = input.value;
        }
        if (slashMenu) {
          slashMenu.classList.toggle('hidden', !input.value.startsWith('/'));
        }
      });
      input.addEventListener('paste', (e) => {
        if (e.clipboardData && e.clipboardData.files && e.clipboardData.files.length > 0) {
          uploadFiles(e.clipboardData.files);
        }
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          form.requestSubmit();
        } else if (e.key === 'Escape' && slashMenu) {
          slashMenu.classList.add('hidden');
        }
      });
    }

    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'i') {
        e.preventDefault();
        toggleInfoPane();
      } else if (e.key === 'Escape') {
        closeThread();
        const lb = document.getElementById('novaMediaLightbox');
        if (lb) lb.classList.add('hidden');
        hideModal('novaMemoryModal');
        hideModal('novaSettingsModal');
        hideModal('novaAgentSettingsModal');
        hideModal('novaPaletteBackdrop');
      } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && document.activeElement && document.activeElement.classList.contains('nova-agent-row')) {
        e.preventDefault();
        const rows = Array.from(document.querySelectorAll('.nova-agent-row[data-agent-id]'));
        const idx = rows.indexOf(document.activeElement);
        if (idx !== -1 && rows.length > 0) {
          const nextIdx = e.key === 'ArrowDown' ? (idx + 1) % rows.length : (idx - 1 + rows.length) % rows.length;
          rows[nextIdx].focus();
          rows[nextIdx].click();
        }
      }
    });

    if (window.lucide) window.lucide.createIcons();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
