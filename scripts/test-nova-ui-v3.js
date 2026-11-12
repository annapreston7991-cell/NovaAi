/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
/**
 * Nova layout v3 acceptance checks (NOVA-UI-1, 2, 7, 13, 14, 15, 16).
 * Renders the real EJS views without a server or database.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

process.env.NODE_ENV = 'test';
const root = path.join(__dirname, '..');
const menuLib = require('../lib/nova_menu');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('✓ ' + name);
}

const bootstrap = {
  settings: { theme: 'dark', accent: 'cyan' },
  agents: [
    { id: 'nova', name: 'Nova', title: 'Guide, builder & companion', color: '#06b6d4' },
    { id: 'astra', name: 'Astra', title: 'Wonder & Synthesis', color: '#c084fc' }
  ],
  conversations: [], routines: [], memories: []
};

function render(useUiV3, isOwner) {
  const file = path.join(root, 'views/novaai_app.ejs');
  const menu = menuLib.forUser(isOwner);
  return ejs.render(fs.readFileSync(file, 'utf8'), {
    user: isOwner ? { id: 3, username: 'owner', role: 'admin' } : { id: 42, username: 'member', role: 'user' },
    isOwnerAdmin: isOwner,
    useUiV3,
    isStandaloneApp: false,
    bootstrap,
    novaMenu: menu,
    novaMenuIndex: menuLib.searchIndex(menu)
  }, { filename: file });
}

const v2Owner = render(false, true);
const v3Owner = render(true, true);
const v3Member = render(true, false);
const allMenuIds = new Set(menuLib.GROUPS.flatMap(g => g.items.map(i => i.id)));
const adminIds = new Set(menuLib.GROUPS.find(g => g.id === 'admin').items.map(i => i.id));

console.log('=== NOVA LAYOUT V3 TESTS ===');

check('menu has the 5 agreed groups in order', () => {
  assert.deepStrictEqual(menuLib.GROUPS.map(g => g.id), ['chats', 'workspace', 'explore', 'settings', 'admin']);
  assert.deepStrictEqual(menuLib.forUser(false).map(g => g.id), ['chats', 'workspace', 'explore', 'settings']);
});

check('menu ids are unique and every item does something', () => {
  const ids = menuLib.GROUPS.flatMap(g => g.items.map(i => i.id));
  assert.strictEqual(new Set(ids).size, ids.length);
  for (const g of menuLib.GROUPS) for (const i of g.items) {
    assert(i.action || i.v3 || i.href || i.list, `${i.id} has no behaviour`);
    assert(i.label && i.icon, `${i.id} needs label and icon`);
  }
});

check('flag off renders the v2 shell, unchanged', () => {
  assert(v2Owner.includes('id="novaMobileTabs"'), 'v2 popup menu expected');
  assert(!v2Owner.includes('nova-v3'), 'no v3 markup or assets when off');
  assert(!v2Owner.includes('__NOVA_MENU__'), 'no v3 menu data when off');
});

check('flag on renders v3 with the ids app.js and gestures.js need', () => {
  for (const id of ['novaSidebar', 'novaAgentList', 'novaTotalUnreadBadge', 'novaRoomList', 'novaSectionsContainer', 'novaConversationList', 'novaV3BottomBar', 'novaInfoPane', 'novaAccountBtn']) {
    assert(v3Owner.includes(`id="${id}"`), `missing #${id}`);
  }
  assert(v3Owner.includes('class="nova-sidebar nova-v3-sidebar"'), 'sidebar must reuse .nova-sidebar (phone drawer)');
  assert(!v3Owner.includes('id="novaMobileTabs"'), 'old popup menu must be gone');
  assert(v3Owner.includes('/css/nova-v3.css') && v3Owner.includes('/js/nova/nova-v3.js'));
  assert(!/w-\[248px\]|translate-y-full|pb-safe/.test(v3Owner), 'no purged Tailwind classes');
});

check('groups are buttons with aria-expanded/aria-controls; icons are hidden from screen readers', () => {
  const groupBtns = v3Owner.match(/<button[^>]*class="nova-v3-group-btn"[^>]*>/g) || [];
  assert.strictEqual(groupBtns.length, 5);
  for (const b of groupBtns) assert(/aria-expanded="(true|false)"/.test(b) && /aria-controls="/.test(b));
  const icons = v3Owner.match(/<i data-lucide="[^"]+"[^>]*>/g) || [];
  const v3Icons = icons.filter(i => !/class="w-/.test(i));
  for (const i of v3Icons) assert(/aria-hidden="true"/.test(i), 'icon without aria-hidden: ' + i);
});

check('member HTML has no Admin markup (NOVA-UI-7, server-side)', () => {
  assert(!v3Member.includes('data-group-id="admin"'));
  assert(!v3Member.includes('novaV3Sheet-admin'));
  assert(!v3Member.includes('novaV3TelemetryModal'));
  assert(!v3Member.includes('novaComputerCard'));
  for (const id of adminIds) assert(!v3Member.includes(`data-menu-id="${id}"`), 'admin item leaked: ' + id);
  const memberIndex = menuLib.searchIndex(menuLib.forUser(false));
  assert(!memberIndex.some(i => adminIds.has(i.id)), 'admin items must not be searchable for members');
  assert(v3Owner.includes('data-group-id="admin"') && v3Owner.includes('novaV3TelemetryModal'));
  assert(!v3Member.includes('data-nova-action="stop-nova"'), 'Stop Nova is admin-only');
  assert(!render(false, false).includes('data-nova-action="stop-nova"'), 'Stop Nova is admin-only in the old layout too');
});

check('no admin page links in rendered v3 HTML, member or owner (WO7-9)', () => {
  const bad = /href="\/(admin|pantheon|training|agent-tasks|analytics|term)\b/;
  assert(!bad.test(v3Member), 'member v3 has an admin link');
  assert(!bad.test(v3Owner), 'owner v3 has an admin link');
});

check('every data-nova-action from the v2 menus is reachable in v3 (NOVA-UI-2)', () => {
  const replacedByV3 = {
    'close-nova-menu': 'sheets close with data-nova-v3="close-sheet"',
    'close-more-sheet': 'sheets close with data-nova-v3="close-sheet"',
    'new-section': 'menu item new-folder (data-nova-v3="new-section")',
    // aliases handled by the same app.js branch as the action v3 uses
    'open-memory-modal': 'open-memory-view',
    'open-settings-modal': 'open-settings'
  };
  const v2Files = ['sidebar.ejs', 'mobile_tabs.ejs', 'chat.ejs', 'composer.ejs', 'info_pane.ejs', 'settings.ejs', 'agent_settings.ejs', 'memory_view.ejs', 'settings_notifications.ejs'];
  const actions = new Set();
  for (const f of v2Files) {
    const src = fs.readFileSync(path.join(root, 'views/partials/nova', f), 'utf8');
    for (const m of src.matchAll(/data-nova-action="([^"]+)"/g)) actions.add(m[1]);
  }
  const missing = [];
  for (const a of actions) {
    if (replacedByV3[a]) {
      if (!replacedByV3[a].includes(' ')) assert(v3Owner.includes(`data-nova-action="${replacedByV3[a]}"`), a + ' alias missing');
      continue;
    }
    if (!v3Owner.includes(`data-nova-action="${a}"`)) missing.push(a);
  }
  assert.deepStrictEqual(missing, [], 'v2 actions missing in v3: ' + missing.join(', '));
  assert(v3Owner.includes('data-nova-v3="new-section"') && v3Owner.includes('data-nova-v3="close-sheet"'));
});

check('every v2 menu link is still in v3 (or replaced)', () => {
  const v2Src = ['sidebar.ejs', 'mobile_tabs.ejs'].map(f => fs.readFileSync(path.join(root, 'views/partials/nova', f), 'utf8')).join('\n');
  const replaced = { '/portal#telemetry': 'Admin > Fleet telemetry' };
  for (const m of v2Src.matchAll(/href="([^"]+)"/g)) {
    const href = m[1];
    if (replaced[href]) continue;
    assert(v3Owner.includes(`href="${href}"`), 'v2 link missing in v3: ' + href);
  }
  assert(v3Owner.includes('data-nova-v3="admin:telemetry"'));
});

check('all 91 inventory items map to something reachable in v3 (NOVA-UI-16)', () => {
  // item number -> menu id (m:), selector text in owner HTML (h:), or widget file (w:)
  const map = {
    1: 'h:data-nova-v3="open-group:explore"', 2: 'm:a-stop', 3: 'm:search', 4: 'm:new-chat', 5: 'h:id="novaAgentList"',
    6: 'h:id="novaTotalUnreadBadge"', 7: 'm:new-council', 8: 'h:id="novaRoomList"', 9: 'm:new-folder', 10: 'h:id="novaConversationList"',
    11: 'm:s-install', 12: 'm:x-help', 13: 'm:s-classic', 14: 'h:id="novaAccountBtn"', 15: 'h:data-nova-v3="close-sheet"',
    16: 'h:data-nova-v3="drawer"', 17: 'm:a-screen', 18: 'm:ws-routines', 19: 'm:ws-memory', 20: 'm:s-you',
    21: 'h:data-nova-v3="sheet:explore"', 22: 'm:x-home', 23: 'm:x-mail', 24: 'm:a-telemetry', 25: 'm:x-aurastream',
    26: 'm:s-you', 27: 'm:x-help', 28: 'h:id="novaResumeBtn"', 29: 'h:data-nova-action="toggle-nova-menu"', 30: 'h:nova-chat-header',
    31: 'h:data-nova-action="cancel-job"', 32: 'h:data-nova-action="toggle-info-pane"', 33: 'h:id="novaEmptyState"', 34: 'h:id="novaCapBanner"', 35: 'h:<span>/telemetry</span>',
    36: 'h:/workspace', 37: 'h:/haven', 38: 'h:/usage', 39: 'h:id="novaPendingAttachments"', 40: 'h:data-nova-action="trigger-upload"',
    41: 'h:data-nova-action="toggle-voice-input"', 42: 'h:data-nova-action="cancel-job"', 43: 'h:/nova/how-it-works', 44: 'h:id="improveNovaComposerCheck"', 45: 'h:id="novaInfoPane"',
    46: 'm:ws-persona', 47: 'm:ws-configure', 48: 'h:id="novaRoomMembersCard"', 49: 'm:a-screen', 50: 'm:a-reset',
    51: 'm:a-files', 52: 'm:a-test-window', 53: 'h:novaLiveScreen', 54: 'h:refresh-computer-files', 55: 'm:a-terminal',
    56: 'm:ws-new-routine', 57: 'm:ws-memory', 58: 'm:ws-usage', 59: 'm:s-plugins', 60: 'm:ws-activity',
    61: 'h:id="novaActivityPersonaFilter"', 62: 'h:id="novaActivitySourceFilter"', 63: 'm:past-chats', 64: 'h:id="novaThreadPanel"', 65: 'h:id="novaSettingTheme"',
    66: 'h:id="novaSettingAccent"', 67: 'h:id="novaSettingDensity"', 68: 'h:id="novaSettingTimezone"', 69: 'h:id="novaSettingChannel"', 70: 'h:id="novaSettingsModal"',
    71: 'h:data-open-secure-form="elevenlabs"', 72: 'm:s-import', 73: 'h:id="novaPushTestBtn"', 74: 'h:id="novaPushPrefsTable"', 75: 'm:s-privacy',
    76: 'm:s-classic', 77: 'm:ws-configure', 78: 'm:a-prompts', 79: 'h:id="novaMemorySearchInput"', 80: 'h:id="novaForgetAllMemoriesBtn"',
    81: 'h:id="novaAddMemoryForm"', 82: 'h:id="novaPaletteBackdrop"', 83: 'h:id="novaMediaLightbox"', 84: 'h:id="novaApprovalCardTemplate"', 85: 'h:/js/nova/gestures.js',
    86: 'h:data-nova-action="install-app"', 87: 'w:', 88: 'w:', 89: 'w:', 90: 'w:', 91: 'm:a-fullscreen'
  };
  const widget = fs.readFileSync(path.join(root, 'views/partials/nova_widget.ejs'), 'utf8');
  for (let n = 1; n <= 91; n++) {
    const target = map[n];
    assert(target, 'inventory item ' + n + ' has no mapping');
    const [kind, value] = [target.slice(0, 1), target.slice(2)];
    if (kind === 'm') {
      assert(allMenuIds.has(value), `item ${n}: unknown menu id ${value}`);
      assert(v3Owner.includes(`data-menu-id="${value}"`), `item ${n}: ${value} not rendered`);
    } else if (kind === 'h') {
      assert(v3Owner.includes(value), `item ${n}: "${value}" not in v3 HTML`);
    } else {
      assert(widget.length > 0);
    }
  }
});

check('text is at least 12px in the v3 views and CSS (WO7 C5)', () => {
  const files = ['views/partials/nova/sidebar_v3.ejs', 'views/partials/nova/mobile_tabs_v3.ejs', 'views/partials/nova/v3_panels.ejs', 'views/partials/nova/v3_item.ejs', 'views/nova_plugins.ejs'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    assert(!/text-\[(\d|1[01])px\]/.test(src), f + ' uses text below 12px');
    for (const m of src.matchAll(/font-size:\s*(\d+)px/g)) assert(Number(m[1]) >= 12, f + ' font-size ' + m[1]);
  }
  const css = fs.readFileSync(path.join(root, 'public/css/nova-v3.css'), 'utf8');
  for (const m of css.matchAll(/font(?:-size)?:\s*(\d+)px/g)) assert(Number(m[1]) >= 12, 'nova-v3.css font-size ' + m[1]);
  assert(/\.text-\\\[10px\\\][^{]*\{[^}]*font-size:\s*12px/.test(css.replace(/\n/g, ' ')), 'small Tailwind text must be raised to 12px in v3');
});

check('tap targets are at least 44px on phone controls (NOVA-UI-4/15)', () => {
  const css = fs.readFileSync(path.join(root, 'public/css/nova-v3.css'), 'utf8');
  for (const sel of ['.nova-v3-group-btn', '.nova-v3-icon-btn', '.nova-v3-btn', '.nova-v3-brand-btn']) {
    const block = css.split(sel + ' {')[1] || css.split(sel + ',')[1] || '';
    assert(/(min-height|height):\s*(4[4-9]|[5-9]\d)px/.test(block.split('}')[0]), sel + ' must be >= 44px');
  }
  assert(/\.nova-v3-sheet \.nova-v3-item \{[^}]*min-height:\s*48px/.test(css));
  assert(/\.nova-v3-tab \{[^}]*min-height:\s*52px/.test(css.replace(/\n/g, ' ')));
  assert(css.includes('env(safe-area-inset-bottom'), 'safe-area padding required');
});

check('layout switch rules: v3 default, kill switch, switch back (NOVA-UI-1/14)', () => {
  const r = menuLib.resolveUiV3;
  assert.strictEqual(r({ env: {} }), true, 'v3 is the default for everyone');
  assert.strictEqual(r({ env: { NOVA_UI_V3: 'false' } }), false, 'kill switch');
  assert.strictEqual(r({ userSettings: { novaUiV3: true }, env: { NOVA_UI_V3: 'false' } }), false, 'kill switch beats member choice');
  assert.strictEqual(r({ query: { ui: 'v3' }, isOwner: true, env: { NOVA_UI_V3: 'false' } }), true, 'owner can still preview');
  assert.strictEqual(r({ query: { ui: 'v3' }, isOwner: false, env: { NOVA_UI_V3: 'false' } }), false, '?ui=v3 is owner-only');
  assert.strictEqual(r({ query: { ui: 'v2' }, isOwner: true, userSettings: { novaUiV3: true }, env: {} }), false);
  assert.strictEqual(r({ userSettings: { novaUiV3: false }, env: {} }), false, 'member can switch back');
  assert.strictEqual(r({ userSettings: { novaUiV3: null }, env: {} }), true);
  assert(v3Owner.includes('data-nova-v3="layout:v2"') && v3Owner.includes('id="novaV3WhereNote"'));
});

check('plugins page renders for a member with AA colours and no tokens', () => {
  const file = path.join(root, 'views/nova_plugins.ejs');
  const html = ejs.render(fs.readFileSync(file, 'utf8'), {
    user: { id: 42, role: 'user' }, isOwnerAdmin: false, connected: 'github', error: 'Visit http://evil.example now <b>',
    plugins: [
      { id: 'github', name: 'GitHub', category: 'Developer', description: 'Repos', ownerOnly: false, needsAccount: true, needsShop: false, connected: true, accountLabel: 'octo', actions: [{ id: 'list_repos', title: 'List my repositories', kind: 'read' }, { id: 'create_issue', title: 'Open an issue', kind: 'write' }] },
      { id: 'shopify', name: 'Shopify', category: 'Commerce', description: 'Shop', ownerOnly: false, needsAccount: true, needsShop: true, connected: false, actions: [] }
    ]
  }, { filename: file });
  assert(html.includes('GitHub</strong> is connected'));
  assert(html.includes('Asks first') && html.includes('data-disconnect="github"'));
  assert(html.includes('name="shop"'));
  assert(!html.includes('evil.example') && !html.includes('<b>'), 'error text must be cleaned');
  assert(html.includes('href="/novaai"'));
  assert(!/href="\/(admin|pantheon|training|agent-tasks|analytics|term)\b/.test(html));
});

console.log(`\n=== ${passed} NOVA LAYOUT V3 CHECKS PASSED ===`);
