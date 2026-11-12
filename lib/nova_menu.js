/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
/**
 * Nova layout v3 menu (NOVA-UI-2): ONE config that feeds the desktop sidebar,
 * the phone bottom bar + sheets, and the Cmd-K search.
 *
 * It lives on the server (not in /public) and is filtered with forUser() before
 * rendering, so a member's page never contains Admin items (NOVA-UI-7).
 *
 * Item fields:
 *   action  -> existing data-nova-action handled by public/js/nova/app.js
 *   v3      -> v3-only behaviour handled by public/js/nova/nova-v3.js
 *   href    -> plain link
 *   list    -> a live list the app fills in (personas, rooms, conversations)
 */

const GROUPS = [
  {
    id: 'chats',
    label: 'Chats',
    icon: 'message-square',
    hint: 'Your conversations and personas',
    items: [
      { id: 'new-chat', label: 'New chat', icon: 'plus', action: 'new-chat', primary: true },
      { id: 'search', label: 'Search everything', icon: 'search', action: 'open-palette', shortcut: '⌘K' },
      { id: 'personas', label: 'Personas', icon: 'sparkles', list: 'personas' },
      { id: 'rooms', label: 'Rooms', icon: 'users', list: 'rooms' },
      { id: 'new-council', label: 'New council room', icon: 'users', action: 'create-council-room' },
      { id: 'conversations', label: 'Conversations', icon: 'messages-square', list: 'conversations' },
      { id: 'new-folder', label: 'New folder', icon: 'folder-plus', v3: 'new-section' },
      { id: 'past-chats', label: 'All past chats', icon: 'history', v3: 'workspace:chats' }
    ]
  },
  {
    id: 'workspace',
    label: 'Workspace',
    icon: 'layout-panel-left',
    hint: 'Persona, routines, memory, usage and activity',
    items: [
      { id: 'ws-persona', label: 'Persona', icon: 'user-round', v3: 'workspace:persona' },
      { id: 'ws-configure', label: 'Configure persona', icon: 'sliders-horizontal', action: 'open-agent-settings' },
      { id: 'ws-routines', label: 'Routines', icon: 'clock', v3: 'workspace:routines' },
      { id: 'ws-new-routine', label: 'New routine', icon: 'calendar-plus', v3: 'workspace:new-routine' },
      { id: 'ws-memory', label: 'Memory', icon: 'brain', action: 'open-memory-view' },
      { id: 'ws-usage', label: 'Usage & daily limits', icon: 'gauge', v3: 'workspace:usage' },
      { id: 'ws-activity', label: 'Activity', icon: 'activity', v3: 'workspace:activity' }
    ]
  },
  {
    id: 'explore',
    label: 'Explore',
    icon: 'compass',
    hint: 'The rest of the LLYVerse',
    items: [
      { id: 'x-home', label: 'LLYVerse home', icon: 'home', href: '/' },
      { id: 'x-aurastream', label: 'AuraStream', icon: 'radio', href: '/aurastream' },
      { id: 'x-studio', label: 'Studio', icon: 'palette', href: '/studio' },
      { id: 'x-academy', label: 'Academy', icon: 'graduation-cap', href: '/academy' },
      { id: 'x-store', label: 'Store', icon: 'shopping-bag', href: '/store' },
      { id: 'x-community', label: 'Community', icon: 'users-round', href: '/blog' },
      { id: 'x-mail', label: 'LLY Mail', icon: 'mail', href: '/mail' },
      { id: 'x-help', label: 'How Nova works', icon: 'circle-help', href: '/nova/how-it-works' },
      { id: 'x-download', label: 'Get the Nova app', icon: 'smartphone', href: '/nova/download' }
    ]
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: 'settings',
    hint: 'You, plugins, privacy and the app',
    items: [
      { id: 's-you', label: 'Look & feel, time zone', icon: 'sun-moon', action: 'open-settings' },
      { id: 's-plugins', label: 'Plugins & connections', icon: 'plug', href: '/novaai/plugins' },
      { id: 's-notifications', label: 'Notifications', icon: 'bell', v3: 'settings:notifications' },
      { id: 's-privacy', label: 'Privacy & data', icon: 'lock', v3: 'settings:privacy' },
      { id: 's-import', label: 'Import chats from this device', icon: 'download', action: 'import-local-storage' },
      { id: 's-install', label: 'Install Nova app', icon: 'download', action: 'install-app' },
      { id: 's-classic', label: 'Classic view', icon: 'monitor', href: '/novaai/classic' },
      { id: 's-old-layout', label: 'Switch back to the old layout', icon: 'undo-2', v3: 'layout:v2' }
    ]
  },
  {
    id: 'admin',
    label: 'Admin',
    icon: 'shield',
    hint: 'Owner only',
    adminOnly: true,
    items: [
      { id: 'a-screen', label: 'Computer: screen', icon: 'monitor', v3: 'computer:screen' },
      { id: 'a-files', label: 'Computer: files', icon: 'folder', v3: 'computer:files' },
      { id: 'a-terminal', label: 'Computer: terminal', icon: 'square-terminal', v3: 'computer:terminal' },
      { id: 'a-test-window', label: 'Open test window', icon: 'app-window', action: 'open-test-window' },
      { id: 'a-reset', label: 'Reset computer', icon: 'rotate-ccw', action: 'reset-computer', danger: true },
      { id: 'a-fullscreen', label: 'Computer full screen', icon: 'maximize', href: '/novaai/computer' },
      { id: 'a-prompts', label: 'System prompts', icon: 'file-text', action: 'open-agent-settings' },
      { id: 'a-telemetry', label: 'Fleet telemetry', icon: 'cpu', v3: 'admin:telemetry' },
      { id: 'a-stop', label: 'Stop Nova', icon: 'octagon', action: 'stop-nova', danger: true },
      { id: 'a-resume', label: 'Resume Nova', icon: 'play', action: 'resume-nova' }
    ]
  }
];

/** Menu for one viewer. Admin group only for the owner (server-side, not hidden with CSS). */
function forUser(isOwnerAdmin) {
  return GROUPS.filter(g => !g.adminOnly || isOwnerAdmin).map(g => ({ ...g, items: g.items.map(i => ({ ...i })) }));
}

/** Flat list for Cmd-K search (no live lists). */
function searchIndex(menu) {
  const out = [];
  for (const g of menu) {
    for (const i of g.items) {
      if (i.list) continue;
      out.push({ id: i.id, label: i.label, group: g.label, action: i.action || null, v3: i.v3 || null, href: i.href || null });
    }
  }
  return out;
}

/**
 * Which layout to render (NOVA-UI-1, NOVA-UI-14). Layout v3 is the default for everyone.
 *   ?ui=v2 always gives the old layout.
 *   NOVA_UI_V3=false is the kill switch: everyone gets the old layout (the owner can still preview with ?ui=v3).
 *   ?ui=v3 previews the new layout for the owner.
 *   Otherwise a member's own choice ("Switch back to the old layout") wins; if they never chose, v3.
 */
function resolveUiV3({ query = {}, isOwner = false, userSettings = {}, env = process.env } = {}) {
  if (query.ui === 'v2') return false;
  if (query.ui === 'v3' && isOwner) return true;
  if (String(env.NOVA_UI_V3 || '').trim().toLowerCase() === 'false') return false;
  if (userSettings && typeof userSettings.novaUiV3 === 'boolean') return userSettings.novaUiV3;
  return true;
}

module.exports = { GROUPS, forUser, searchIndex, resolveUiV3 };
