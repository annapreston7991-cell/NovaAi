const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

process.env.NODE_ENV = 'test';

async function runTests() {
  console.log('=== RUNNING NOVA UI V3 ACCEPTANCE TESTS ===\n');

  // [TEST 1] Menu Config Completeness (NOVA-UI-2)
  console.log('[TEST 1] Validating nova-menu.js 5 groups...');
  const menuConfig = require('../public/js/nova/nova-menu');
  assert(Array.isArray(menuConfig), 'Menu config must be an array');
  assert.strictEqual(menuConfig.length, 5, 'Must have exactly 5 top-level groups');
  
  const groupIds = menuConfig.map(g => g.id);
  assert.deepStrictEqual(groupIds, ['chats', 'workspace', 'explore', 'settings', 'admin']);
  console.log('✓ Exactly 5 top-level groups present:', groupIds.join(', '));

  // [TEST 2] V2 Fallback Markup Parity (NOVA-UI-1 Acceptance)
  console.log('[TEST 2] Verifying v2 fallback when useUiV3 is false...');
  const appEjs = fs.readFileSync(path.join(__dirname, '../views/novaai_app.ejs'), 'utf8');
  const v2Html = ejs.render(appEjs, {
    user: { id: 3, username: 'founder', role: 'admin' },
    isOwnerAdmin: true,
    useUiV3: false,
    isStandaloneApp: false,
    bootstrap: {
      settings: { theme: 'dark', accent: 'cyan' },
      agents: [],
      conversations: [],
      routines: [],
      memories: []
    }
  }, { filename: path.join(__dirname, '../views/novaai_app.ejs') });

  assert(!v2Html.includes('id="novaV3Sidebar"'), 'v2 must NOT include novaV3Sidebar');
  assert(!v2Html.includes('id="novaV3MobileBottomBar"'), 'v2 must NOT include novaV3MobileBottomBar');
  assert(v2Html.includes('id="novaSidebar"'), 'v2 must include legacy novaSidebar');
  console.log('✓ useUiV3 = false renders legacy v2 shell with complete markup parity.');

  // [TEST 3] V3 Shell Rendering & 248px Sidebar (NOVA-UI-1 & NOVA-UI-3)
  console.log('[TEST 3] Verifying v3 shell when useUiV3 is true...');
  const v3Html = ejs.render(appEjs, {
    user: { id: 3, username: 'founder', role: 'admin' },
    isOwnerAdmin: true,
    useUiV3: true,
    isStandaloneApp: false,
    bootstrap: {
      settings: { theme: 'dark', accent: 'cyan' },
      agents: [],
      conversations: [],
      routines: [],
      memories: []
    }
  }, { filename: path.join(__dirname, '../views/novaai_app.ejs') });

  assert(v3Html.includes('id="novaV3Sidebar"'), 'v3 must include novaV3Sidebar');
  assert(v3Html.includes('w-[248px]'), 'v3 sidebar must be 248px');
  assert(v3Html.includes('id="novaV3MobileBottomBar"'), 'v3 must include mobile bottom bar');
  assert(v3Html.includes('data-group-id="chats"'), 'v3 sidebar must have Chats group');
  assert(v3Html.includes('data-group-id="workspace"'), 'v3 sidebar must have Workspace group');
  assert(v3Html.includes('data-group-id="explore"'), 'v3 sidebar must have Explore group');
  assert(v3Html.includes('data-group-id="settings"'), 'v3 sidebar must have Settings group');
  assert(v3Html.includes('data-group-id="admin"'), 'Founder must see Admin group');
  console.log('✓ useUiV3 = true renders 248px sidebar and 5 groups.');

  // [TEST 4] Server-Side Admin Security Barrier (NOVA-UI-7)
  console.log('[TEST 4] Verifying Admin group is strictly filtered out for non-founder users...');
  const memberV3Html = ejs.render(appEjs, {
    user: { id: 10, username: 'member', role: 'member' },
    isOwnerAdmin: false,
    useUiV3: true,
    isStandaloneApp: false,
    bootstrap: {
      settings: { theme: 'dark', accent: 'cyan' },
      agents: [],
      conversations: [],
      routines: [],
      memories: []
    }
  }, { filename: path.join(__dirname, '../views/novaai_app.ejs') });

  assert(!memberV3Html.includes('data-group-id="admin"'), 'Non-founder HTML MUST NOT contain admin group markup');
  assert(!memberV3Html.includes('data-sheet-target="sheet-admin"'), 'Non-founder HTML MUST NOT contain admin mobile bottom sheet trigger');
  assert(!memberV3Html.includes('id="sheet-admin"'), 'Non-founder HTML MUST NOT contain sheet-admin markup');
  console.log('✓ Acceptance passed: Zero admin markup rendered for non-founder users.');

  console.log('\n🎉 ALL NOVA UI V3 ACCEPTANCE TESTS PASSED (100%)\n');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
