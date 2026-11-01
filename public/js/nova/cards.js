/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
/**
 * Nova Interactive Card Renderers (§5.1–§5.3, §15.1)
 * Renders Question, Approval (with two-click confirm for danger actions),
 * and Secure Form cards (masked password toggle, never logged).
 */
(function (root) {
  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function isCardExpired(payload) {
    if (!payload) return false;
    if (payload.expired) return true;
    if (!payload.answered && payload.expiresAt) {
      const exp = new Date(payload.expiresAt).getTime();
      if (!Number.isNaN(exp) && exp <= Date.now()) return true;
    }
    return false;
  }

  function question(msg) {
    const p = msg.payload || {};
    const widgetId = p.widgetId || '';
    const expired = isCardExpired(p);

    if (p.answered && p.answer) {
      const labels = Array.isArray(p.answer.labels) && p.answer.labels.length > 0
        ? p.answer.labels.join(', ')
        : (Array.isArray(p.answer.selected) ? p.answer.selected.join(', ') : 'Answered');
      return `
        <div class="nova-card nova-card-question is-answered my-1 p-3.5 rounded-2xl bg-white/[0.03] border border-white/10 max-w-xl opacity-80 space-y-1.5" data-widget-id="${escapeHtml(widgetId)}">
          <div class="text-xs font-semibold text-slate-300">${escapeHtml(p.prompt || 'Question')}</div>
          <div class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-cyan-500/15 border border-cyan-400/30 text-xs text-cyan-200 font-medium">
            <span>✓</span>
            <span>${escapeHtml(labels)}</span>
          </div>
        </div>
      `;
    }

    if (expired) {
      return `
        <div class="nova-card nova-card-question is-expired my-1 p-3.5 rounded-2xl bg-white/[0.02] border border-white/10 max-w-xl opacity-60 flex items-center justify-between" data-widget-id="${escapeHtml(widgetId)}">
          <span class="text-xs text-slate-400">${escapeHtml(p.prompt || 'Question')}</span>
          <span class="px-2 py-0.5 rounded bg-white/10 text-[10px] font-mono uppercase text-slate-400">Expired</span>
        </div>
      `;
    }

    const options = Array.isArray(p.options) ? p.options : [];
    const multi = Boolean(p.multiSelect);
    const allowCustom = Boolean(p.allowCustom);

    const optionsHtml = options.map(opt => {
      const style = opt.style || 'default';
      const btnCls = style === 'primary'
        ? 'bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold border-transparent'
        : style === 'danger'
          ? 'bg-rose-500/20 hover:bg-rose-500/30 text-rose-200 border-rose-500/40 font-semibold'
          : 'bg-white/5 hover:bg-white/10 text-slate-200 border-white/15 font-medium';
      return `
        <button
          type="button"
          data-card-q-option="${escapeHtml(opt.id)}"
          data-card-widget-id="${escapeHtml(widgetId)}"
          data-card-multi="${multi ? '1' : '0'}"
          class="w-full sm:w-auto px-3.5 py-2 rounded-xl border text-xs transition ${btnCls}"
        >
          ${escapeHtml(opt.label)}
        </button>
      `;
    }).join('');

    return `
      <div class="nova-card nova-card-question my-1 p-4 rounded-2xl bg-[#101424] border border-cyan-500/30 max-w-xl space-y-3" data-widget-id="${escapeHtml(widgetId)}">
        <div class="space-y-1">
          <div class="font-bold text-sm text-white">${escapeHtml(p.prompt || '')}</div>
          ${p.help ? `<div class="text-xs text-slate-400">${escapeHtml(p.help)}</div>` : ''}
        </div>
        <div class="flex flex-col sm:flex-row sm:flex-wrap gap-2">${optionsHtml}</div>
        ${allowCustom ? `
          <div class="flex items-center gap-2 pt-1">
            <input
              type="text"
              data-card-q-custom="${escapeHtml(widgetId)}"
              placeholder="${escapeHtml(p.customPlaceholder || 'Something else...')}"
              class="flex-1 px-3 py-1.5 rounded-xl bg-black/40 border border-white/15 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-cyan-400"
            />
            <button
              type="button"
              data-card-q-submit="${escapeHtml(widgetId)}"
              class="px-3 py-1.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-xs transition"
            >
              Submit
            </button>
          </div>
        ` : (multi ? `
          <div class="pt-1">
            <button
              type="button"
              data-card-q-submit="${escapeHtml(widgetId)}"
              class="px-3.5 py-1.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-xs transition"
            >
              Submit selected
            </button>
          </div>
        ` : '')}
      </div>
    `;
  }

  function approval(msg) {
    const p = msg.payload || {};
    const widgetId = p.widgetId || '';
    const expired = isCardExpired(p);

    if (p.answered && p.answer) {
      const approved = p.answer.decision === 'confirm' || (Array.isArray(p.answer.selected) && p.answer.selected[0] === 'confirm');
      return `
        <div class="nova-card nova-card-approval is-answered my-1 p-3.5 rounded-2xl bg-white/[0.03] border border-white/10 max-w-xl opacity-80 space-y-1.5" data-widget-id="${escapeHtml(widgetId)}">
          <div class="text-xs font-semibold text-slate-300">${escapeHtml(p.title || 'Approval')}</div>
          <div class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg ${approved ? 'bg-emerald-500/15 border-emerald-400/30 text-emerald-200' : 'bg-white/10 border-white/15 text-slate-300'} border text-xs font-medium">
            <span>${approved ? '✓ Approved' : '✕ Cancelled'}</span>
            <span>· ${escapeHtml(p.answer.label || '')}</span>
          </div>
        </div>
      `;
    }

    if (expired) {
      return `
        <div class="nova-card nova-card-approval is-expired my-1 p-3.5 rounded-2xl bg-white/[0.02] border border-white/10 max-w-xl opacity-60 flex items-center justify-between" data-widget-id="${escapeHtml(widgetId)}">
          <span class="text-xs text-slate-400">${escapeHtml(p.title || 'Approval required')}</span>
          <span class="px-2 py-0.5 rounded bg-white/10 text-[10px] font-mono uppercase text-slate-400">Expired</span>
        </div>
      `;
    }

    const confirmCfg = p.confirm || { label: 'Confirm', style: 'danger', doubleConfirm: true };
    const cancelCfg = p.cancel || { label: 'Cancel' };
    const isDanger = confirmCfg.style !== 'primary';
    const doubleConfirm = confirmCfg.doubleConfirm !== false;

    return `
      <div class="nova-card nova-card-approval my-1 p-4 rounded-2xl bg-[#140d16] border ${isDanger ? 'border-rose-500/40' : 'border-cyan-500/40'} max-w-xl space-y-3" data-widget-id="${escapeHtml(widgetId)}">
        <div class="flex items-center justify-between gap-2">
          <span class="text-[11px] font-mono uppercase tracking-wider ${isDanger ? 'text-rose-300' : 'text-cyan-300'} font-bold">
            ⚠️ Approval Required
          </span>
          <span class="text-[10px] font-mono text-slate-400">Single-use token · 5m expiry</span>
        </div>
        <div class="font-bold text-sm text-white">${escapeHtml(p.title || 'Confirm action')}</div>
        <div class="space-y-1">
          <div class="text-[10px] font-mono uppercase tracking-wider text-slate-400">What will happen</div>
          <pre class="p-2.5 rounded-xl bg-black/60 border border-white/10 font-mono text-xs text-slate-200 whitespace-pre-wrap overflow-x-auto">${escapeHtml(p.details || '')}</pre>
        </div>
        <div class="flex items-center gap-2 pt-1">
          <button
            type="button"
            data-card-approval-confirm="${escapeHtml(widgetId)}"
            data-double-confirm="${doubleConfirm ? '1' : '0'}"
            data-orig-label="${escapeHtml(confirmCfg.label || 'Confirm')}"
            class="px-3.5 py-2 rounded-xl font-bold text-xs transition ${isDanger ? 'bg-rose-500 hover:bg-rose-400 text-slate-950' : 'bg-cyan-500 hover:bg-cyan-400 text-slate-950'}"
          >
            ${escapeHtml(confirmCfg.label || 'Confirm')}
          </button>
          <button
            type="button"
            data-card-approval-cancel="${escapeHtml(widgetId)}"
            class="px-3.5 py-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/15 text-slate-200 font-medium text-xs transition"
          >
            ${escapeHtml(cancelCfg.label || 'Cancel')}
          </button>
        </div>
      </div>
    `;
  }

  function secureForm(msg) {
    const p = msg.payload || {};
    const formId = p.formId || '';
    const targetLabel = (p.target && p.target.label) || 'Secure Vault';
    const expired = isCardExpired(p);

    if (p.answered) {
      const fieldsList = p.answer && Array.isArray(p.answer.fields) ? p.answer.fields.join(', ') : '';
      return `
        <div class="nova-card nova-card-secure-form is-answered my-1 p-3.5 rounded-2xl bg-white/[0.03] border border-emerald-500/25 max-w-xl opacity-85 space-y-1" data-form-id="${escapeHtml(formId)}">
          <div class="flex items-center gap-1.5 text-xs font-semibold text-emerald-300">
            <span>🔒</span>
            <span>${escapeHtml(p.title || 'Secure form')} · Connected</span>
          </div>
          <div class="text-[11px] font-mono text-slate-400">
            Encrypted in nova_secrets (${escapeHtml(fieldsList || 'credentials')})
          </div>
        </div>
      `;
    }

    if (expired) {
      return `
        <div class="nova-card nova-card-secure-form is-expired my-1 p-3.5 rounded-2xl bg-white/[0.02] border border-white/10 max-w-xl opacity-60 flex items-center justify-between" data-form-id="${escapeHtml(formId)}">
          <span class="text-xs text-slate-400">🔒 ${escapeHtml(p.title || 'Secure form')}</span>
          <span class="px-2 py-0.5 rounded bg-white/10 text-[10px] font-mono uppercase text-slate-400">Expired</span>
        </div>
      `;
    }

    const fields = Array.isArray(p.fields) ? p.fields : [];
    const fieldsHtml = fields.map(f => {
      const isPwd = f.type === 'password';
      const inputId = `sf_${formId}_${f.name}`;
      return `
        <div class="space-y-1">
          <label for="${escapeHtml(inputId)}" class="block text-[11px] font-medium text-slate-300">
            ${escapeHtml(f.label || f.name)}${f.required ? ' <span class="text-rose-400">*</span>' : ''}
          </label>
          <div class="relative flex items-center">
            <input
              id="${escapeHtml(inputId)}"
              name="${escapeHtml(f.name)}"
              type="${escapeHtml(f.type || 'text')}"
              ${f.required ? 'required' : ''}
              autocomplete="${escapeHtml(f.autocomplete || (isPwd ? 'off' : 'username'))}"
              class="w-full px-3 py-2 rounded-xl bg-black/50 border border-white/15 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-emerald-400"
            />
            ${isPwd ? `
              <button
                type="button"
                data-toggle-pwd="${escapeHtml(inputId)}"
                class="absolute right-2 px-2 py-0.5 rounded bg-white/5 hover:bg-white/10 text-[10px] font-mono text-slate-300"
              >
                Show
              </button>
            ` : ''}
          </div>
        </div>
      `;
    }).join('');

    return `
      <div class="nova-card nova-card-secure-form my-1 p-4 rounded-2xl bg-[#0e1718] border border-emerald-500/40 max-w-xl space-y-3" data-form-id="${escapeHtml(formId)}">
        <div class="flex items-center justify-between gap-2">
          <span class="text-[11px] font-mono text-emerald-300 font-semibold">
            🔒 Secure form · goes to: ${escapeHtml(targetLabel)}
          </span>
          <span class="text-[10px] font-mono text-slate-400">AES-256-GCM</span>
        </div>
        <div class="font-bold text-sm text-white">${escapeHtml(p.title || 'Enter credentials')}</div>
        <form data-nova-secure-form="${escapeHtml(formId)}" class="space-y-2.5" autocomplete="off">
          ${fieldsHtml}
          <div class="flex items-center gap-2 pt-2">
            <button
              type="submit"
              class="px-3.5 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs transition"
            >
              ${escapeHtml(p.submitLabel || 'Connect')}
            </button>
            <button
              type="button"
              data-card-sf-cancel="${escapeHtml(formId)}"
              class="px-3 py-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/15 text-slate-300 text-xs transition"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    `;
  }

  function secureFormResult(msg) {
    const p = msg.payload || {};
    const fields = Array.isArray(p.fields) ? p.fields.join(', ') : '';
    const label = (p.target && p.target.label) || 'Connector';
    return `
      <div class="my-1 px-3 py-2 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-200 inline-flex items-center gap-2">
        <span>🔒</span>
        <span><strong>${escapeHtml(label)}</strong> credentials saved (${escapeHtml(fields || 'encrypted')})</span>
      </div>
    `;
  }

  root.NovaCards = {
    question,
    approval,
    secureForm,
    secureFormResult
  };
})(typeof window !== 'undefined' ? window : globalThis);
