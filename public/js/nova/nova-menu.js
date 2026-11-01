/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 *
 * NOVA-UI-2: Unified 5-Group Menu Configuration
 * Groups: Chats, Workspace, Explore, Settings, Admin (founder-only)
 */

(function (global) {
  'use strict';

  const NOVA_MENU_CONFIG = [
    {
      id: 'chats',
      label: 'Chats',
      icon: 'message-square',
      description: 'Conversations, personas, and recent threads',
      items: [
        { id: 'new-chat', label: 'New Chat', icon: 'plus-circle', action: 'new-chat', shortcut: '⌘N' },
        { id: 'open-palette', label: 'Search & Palette', icon: 'search', action: 'open-palette', shortcut: '⌘K' },
        { id: 'council-room', label: 'Pantheon Council Room', icon: 'users', action: 'create-council-room' },
        { id: 'new-section', label: 'New Folder / Section', icon: 'folder-plus', action: 'new-section' },
        { id: 'import-local', label: 'Import Local Chats', icon: 'download-cloud', action: 'import-local-storage' }
      ]
    },
    {
      id: 'workspace',
      label: 'Workspace',
      icon: 'briefcase',
      description: 'Intelligence tools, memory, routines, and telemetry',
      items: [
        { id: 'toggle-workspace-pane', label: 'Workspace Inspector', icon: 'layout-sidebar-reverse', action: 'toggle-info-pane' },
        { id: 'open-memory', label: 'Memory Vault', icon: 'brain', action: 'open-memory-view' },
        { id: 'new-routine', label: 'Routines & Automation', icon: 'calendar', action: 'toggle-new-routine' },
        { id: 'agent-settings', label: 'Persona & Voice Tuning', icon: 'sliders', action: 'open-agent-settings' },
        { id: 'voice-preview', label: 'Test Voice Speech', icon: 'volume-2', action: 'voice-preview' },
        { id: 'refresh-actions', label: 'Activity & Audit Log', icon: 'activity', action: 'refresh-actions' },
        { id: 'toggle-voice-input', label: 'Voice Dictation', icon: 'mic', action: 'toggle-voice-input' },
        { id: 'trigger-upload', label: 'Upload Media / Files', icon: 'paperclip', action: 'trigger-upload' }
      ]
    },
    {
      id: 'explore',
      label: 'Explore',
      icon: 'compass',
      description: 'LLYVerse ecosystem portals, apps, and documentation',
      items: [
        { id: 'nav-home', label: 'LLYVerse Home', icon: 'home', href: '/' },
        { id: 'nav-aurastream', label: 'AuraStream Music', icon: 'headphones', href: '/aurastream' },
        { id: 'nav-studio', label: 'Creative Studio', icon: 'layers', href: '/studio' },
        { id: 'nav-academy', label: 'The Academy & ERT', icon: 'graduation-cap', href: '/academy' },
        { id: 'nav-store', label: 'Store & QuikDocs', icon: 'sparkles', href: '/store' },
        { id: 'nav-community', label: 'Community Forum', icon: 'messages-square', href: '/blog' },
        { id: 'nav-haven', label: 'Haven Sanctuary', icon: 'shield', href: '/haven' },
        { id: 'nav-how-it-works', label: 'How Nova Works', icon: 'help-circle', href: '/nova/how-it-works' },
        { id: 'nav-download', label: 'Download Desktop / App', icon: 'download', href: '/nova/download' }
      ]
    },
    {
      id: 'settings',
      label: 'Settings',
      icon: 'settings',
      description: 'Preferences, appearance, notifications, and privacy',
      items: [
        { id: 'open-settings', label: 'General Preferences', icon: 'sliders-horizontal', action: 'open-settings' },
        { id: 'open-theme-settings', label: 'Theme & Appearance', icon: 'sun-moon', action: 'open-settings' },
        { id: 'send-test-push', label: 'Push Notifications', icon: 'bell', action: 'send-test-push' },
        { id: 'privacy-settings', label: 'Privacy & Opt-In', icon: 'lock', action: 'open-settings' },
        { id: 'install-app', label: 'Install Standalone App', icon: 'download', action: 'install-app' },
        { id: 'forget-memories', label: 'Wipe Memories', icon: 'trash-2', action: 'forget-all-memories', danger: true }
      ]
    },
    {
      id: 'admin',
      label: 'Admin',
      icon: 'shield-alert',
      adminOnly: true,
      description: 'Founder-only controls, computer workstation, and fleet management',
      items: [
        { id: 'reconnect-screen', label: 'Desktop Screen Stream', icon: 'monitor', action: 'reconnect-screen' },
        { id: 'refresh-files', label: 'Computer Workspace Files', icon: 'folder-git-2', action: 'refresh-computer-files' },
        { id: 'test-window', label: 'Launch Test Window', icon: 'app-window', action: 'open-test-window' },
        { id: 'reset-computer', label: 'Reset Computer Sandbox', icon: 'refresh-cw', action: 'reset-computer', danger: true },
        { id: 'nav-admin-console', label: 'Admin Master Console', icon: 'terminal', href: '/admin' },
        { id: 'nav-training', label: 'Neural Training Studio', icon: 'cpu', href: '/training' },
        { id: 'nav-agent-tasks', label: 'Agent Tasks Fleet', icon: 'list-todo', href: '/agent-tasks' },
        { id: 'stop-nova', label: 'Emergency Stop Nova', icon: 'octagon', action: 'stop-nova', danger: true },
        { id: 'resume-nova', label: 'Resume Nova Engine', icon: 'play', action: 'resume-nova' }
      ]
    }
  ];

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = NOVA_MENU_CONFIG;
  } else {
    global.NOVA_MENU_CONFIG = NOVA_MENU_CONFIG;
  }
})(typeof window !== 'undefined' ? window : globalThis);
