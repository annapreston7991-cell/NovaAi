/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
/**
 * Nova Rich Markdown, Code, KaTeX Math, Strict Mermaid & Link Pill Renderer (§4.3, §4.5, §12)
 * Uses local marked + DOMPurify. Never injects unsanitized HTML.
 */
(function (root) {
  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Lightweight KaTeX-compatible math formatter (zero external font/CDN requests)
  const MATH_SYMBOLS = {
    '\\alpha': 'α', '\\beta': 'β', '\\gamma': 'γ', '\\delta': 'δ', '\\epsilon': 'ϵ',
    '\\theta': 'θ', '\\lambda': 'λ', '\\mu': 'μ', '\\nu': 'ν', '\\pi': 'π',
    '\\rho': 'ρ', '\\sigma': 'σ', '\\tau': 'τ', '\\phi': 'ϕ', '\\psi': 'ψ', '\\omega': 'ω',
    '\\Delta': 'Δ', '\\Sigma': 'Σ', '\\Phi': 'Φ', '\\Psi': 'Ψ', '\\Omega': 'Ω',
    '\\times': '×', '\\cdot': '·', '\\pm': '±', '\\leq': '≤', '\\geq': '≥',
    '\\neq': '≠', '\\approx': '≈', '\\infty': '∞', '\\partial': '∂', '\\nabla': '∇',
    '\\int': '∫', '\\sum': '∑', '\\prod': '∏', '\\rightarrow': '→', '\\Rightarrow': '⇒'
  };

  function renderMathExpr(tex, isDisplay = false) {
    let out = escapeHtml(String(tex || '').trim());
    for (const [k, v] of Object.entries(MATH_SYMBOLS)) {
      out = out.split(k).join(v);
    }
    // Fractions \frac{a}{b}
    out = out.replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, '<span class="nova-math-frac"><span class="nova-math-num">$1</span><span class="nova-math-den">$2</span></span>');
    // Superscripts & subscripts
    out = out.replace(/\^\{([^{}]+)\}/g, '<sup>$1</sup>').replace(/\^([a-zA-Z0-9+-])/g, '<sup>$1</sup>');
    out = out.replace(/_\{([^{}]+)\}/g, '<sub>$1</sub>').replace(/_([a-zA-Z0-9+-])/g, '<sub>$1</sub>');

    const cls = isDisplay
      ? 'nova-katex-block my-2 py-2 px-3 rounded-xl bg-black/40 border border-cyan-500/20 text-center font-serif text-cyan-200 block overflow-x-auto'
      : 'nova-katex-inline px-1 rounded bg-cyan-500/10 text-cyan-200 font-serif';
    return `<span class="${cls}" role="math" aria-label="${escapeHtml(tex)}">${out}</span>`;
  }

  // Strict client-side SVG Mermaid renderer (flowchart / graph / sequenceDiagram) with source fallback (§4.3)
  function renderMermaidStrict(code) {
    const clean = String(code || '').trim();
    const lines = clean.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) return `<pre class="nova-mermaid-fallback"><code>${escapeHtml(clean)}</code></pre>`;

    const header = lines[0];
    if (!/^(flowchart|graph|sequenceDiagram|stateDiagram)/i.test(header)) {
      return `<pre class="nova-mermaid-fallback p-3 rounded-xl bg-black/50 border border-white/10 font-mono text-xs"><code>${escapeHtml(clean)}</code></pre>`;
    }

    // Parse nodes and edges for flowchart/graph/sequence
    const edges = [];
    const nodesMap = new Map();

    function ensureNode(id, label) {
      const cleanId = id.replace(/[^a-zA-Z0-9_]/g, '_');
      if (!nodesMap.has(cleanId)) {
        nodesMap.set(cleanId, (label || id).replace(/^["'\[\(]+|["'\]\)]+$/g, ''));
      }
      return cleanId;
    }

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const match = line.match(/^([A-Za-z0-9_]+)(?:\[([^\]]+)\]|"([^"]+)"|\(([^)]+)\))?\s*(?:-->|-->>|->|---)\s*(?:\|([^|]+)\|\s*)?([A-Za-z0-9_]+)(?:\[([^\]]+)\]|"([^"]+)"|\(([^)]+)\))?/);
      if (match) {
        const fromId = ensureNode(match[1], match[2] || match[3] || match[4] || match[1]);
        const toId = ensureNode(match[6], match[7] || match[8] || match[9] || match[6]);
        edges.push({ from: fromId, to: toId, label: match[5] || '' });
      }
    }

    if (nodesMap.size === 0) {
      return `<pre class="nova-mermaid-fallback p-3 rounded-xl bg-black/50 border border-white/10 font-mono text-xs"><code>${escapeHtml(clean)}</code></pre>`;
    }

    const entries = Array.from(nodesMap.entries());
    const width = Math.max(360, entries.length * 150);
    const height = 110;
    let svgInner = '';

    entries.forEach(([id, label], idx) => {
      const x = 20 + idx * 145;
      const y = 30;
      svgInner += `
        <g transform="translate(${x}, ${y})">
          <rect width="115" height="44" rx="10" fill="#0b0d17" stroke="#06b6d4" stroke-width="1.5" />
          <text x="57.5" y="26" fill="#f8fafc" font-size="11" font-family="monospace" text-anchor="middle">${escapeHtml(label.slice(0, 16))}</text>
        </g>
      `;
      if (idx < entries.length - 1) {
        const ax1 = x + 115;
        const ax2 = x + 145;
        svgInner += `<line x1="${ax1}" y1="52" x2="${ax2}" y2="52" stroke="#06b6d4" stroke-width="1.5" />`;
      }
    });

    return `
      <div class="nova-mermaid-diagram my-2 p-3 rounded-xl bg-black/50 border border-cyan-500/30 overflow-x-auto" data-mermaid-strict="true">
        <svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="Mermaid diagram">
          ${svgInner}
        </svg>
      </div>
    `;
  }

  function highlightCode(code, lang) {
    let escaped = escapeHtml(code);
    escaped = escaped.replace(/\b(const|let|var|function|return|async|await|if|else|for|while|class|import|from|export|try|catch|finally|new|SELECT|FROM|WHERE|INSERT|INTO|UPDATE|DELETE|CREATE|TABLE)\b/g, '<span class="text-cyan-300 font-semibold">$1</span>');
    return escaped;
  }

  function extractLinkPills(markdownText) {
    const text = String(markdownText || '');
    const pills = [];
    const seen = new Set();

    // Markdown links [label](url)
    const mdRegex = /\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/[a-zA-Z0-9_\-\/.?=&]+)\)/g;
    let m;
    while ((m = mdRegex.exec(text)) !== null) {
      const label = m[1].trim();
      const url = m[2].trim();
      if (!seen.has(url)) {
        seen.add(url);
        pills.push(buildPillMeta(url, label));
      }
    }

    // Bare URLs
    const bareRegex = /(^|[\s(])(https?:\/\/[^\s)<>"']+)/g;
    while ((m = bareRegex.exec(text)) !== null) {
      const url = m[2].trim();
      if (!seen.has(url)) {
        seen.add(url);
        pills.push(buildPillMeta(url, null));
      }
    }
    return pills;
  }

  function buildPillMeta(url, label) {
    const isInternal = url.startsWith('/') || /^https?:\/\/([a-z0-9-]+\.)?llyverse\.org(\/|$)/i.test(url);
    let domain = 'llyverse.org';
    if (!url.startsWith('/')) {
      try { domain = new URL(url).hostname.replace(/^www\./, ''); } catch (e) {}
    }
    return {
      url,
      href: url,
      label: label || (url.startsWith('/') ? url : domain),
      domain,
      isInternal
    };
  }

  function renderMarkdown(rawText) {
    if (!rawText) return '';
    let src = String(rawText);

    // 1. Extract code & mermaid blocks first so math/markdown doesn't mangle them
    const placeholders = [];
    src = src.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
      const cleanLang = (lang || 'text').toLowerCase();
      const idx = placeholders.length;
      if (cleanLang === 'mermaid') {
        placeholders.push(renderMermaidStrict(code));
      } else {
        const encodedRaw = encodeURIComponent(code);
        placeholders.push(`
          <div class="nova-code-block my-2 rounded-xl overflow-hidden border border-white/10 bg-black/70">
            <div class="flex items-center justify-between px-3 py-1.5 bg-white/5 border-b border-white/10 text-[11px] font-mono text-slate-400">
              <span>${escapeHtml(cleanLang)}</span>
              <button type="button" data-copy-code="${encodedRaw}" class="text-cyan-400 hover:text-cyan-300 font-sans">Copy</button>
            </div>
            <pre class="p-3 font-mono text-xs overflow-x-auto leading-relaxed"><code>${highlightCode(code, cleanLang)}</code></pre>
          </div>
        `);
      }
      return `\n@@NOVA_BLOCK_${idx}@@\n`;
    });

    // 2. Extract block math $$...$$ and inline math $...$
    src = src.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => {
      const idx = placeholders.length;
      placeholders.push(renderMathExpr(tex, true));
      return `@@NOVA_BLOCK_${idx}@@`;
    });
    src = src.replace(/(^|[\s(])\$([^$\n]+?)\$(?=[\s.,;!?)]|$)/g, (_, pre, tex) => {
      const idx = placeholders.length;
      placeholders.push(renderMathExpr(tex, false));
      return `${pre}@@NOVA_BLOCK_${idx}@@`;
    });

    // 3. Parse Markdown with marked (if loaded) or safe fallback with GFM tables
    let html = '';
    if (root.marked && typeof root.marked.parse === 'function') {
      html = root.marked.parse(src, { breaks: true, gfm: true });
    } else {
      html = escapeHtml(src)
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>')
        .replace(/`([^`\n]+)`/g, '<code class="px-1.5 py-0.5 rounded bg-slate-800 text-cyan-300 font-mono text-xs">$1</code>')
        .replace(/\n/g, '<br>');
    }

    // Wrap tables in horizontal scroll container (§4.3)
    html = html.replace(/<table>/g, '<div class="nova-table-wrap overflow-x-auto my-2 rounded-xl border border-white/10"><table class="nova-table w-full text-left text-xs border-collapse">')
               .replace(/<\/table>/g, '</table></div>');

    // Restore placeholders
    html = html.replace(/@@NOVA_BLOCK_(\d+)@@/g, (_, i) => placeholders[Number(i)] || '');

    // 4. Sanitize with DOMPurify (§4.3, §12)
    if (root.DOMPurify && typeof root.DOMPurify.sanitize === 'function') {
      html = root.DOMPurify.sanitize(html);
    }
    return html;
  }

  root.NovaRender = {
    escapeHtml,
    renderMarkdown,
    renderMathExpr,
    renderMermaidStrict,
    extractLinkPills
  };
})(typeof window !== 'undefined' ? window : globalThis);
