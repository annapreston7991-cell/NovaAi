/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
/**
 * Nova Mobile (<768px), Galaxy Fold Dual-Pane & Top-Icon Popup Menu Controller (§8, §10)
 * - Clicking Nova's icon at the top of the screen toggles the popup menu (#novaMobileTabs)
 * - Left-edge swipe (start <= 24px, deltaX >= 60px) opens sidebar drawer on phones
 * - Swipe-left on sidebar or tap scrim closes sidebar
 * - Swipe-down on Info Sheet closes it
 * - visualViewport keyboard pinning so composer never sits under iOS/Android keyboard
 * - Galaxy Fold dual-pane detection (horizontal-viewport-segments: 2 / unfolded near-square)
 */
(function () {
  'use strict';

  function isMobilePhoneViewport() {
    if (isFoldUnfoldedViewport()) return false;
    return window.innerWidth < 768;
  }

  function isFoldUnfoldedViewport() {
    if (window.matchMedia('(horizontal-viewport-segments: 2)').matches) {
      return true;
    }
    if (
      window.matchMedia('(min-width: 640px) and (max-width: 900px) and (max-aspect-ratio: 4/3)').matches
    ) {
      return true;
    }
    return false;
  }

  function ensureMobileScrim() {
    let scrim = document.getElementById('novaMobileScrim');
    if (!scrim) {
      scrim = document.createElement('div');
      scrim.id = 'novaMobileScrim';
      scrim.className = 'nova-mobile-scrim is-hidden hidden';
      document.body.appendChild(scrim);
      scrim.addEventListener('click', () => {
        closeMobileDrawers();
      });
    }
    return scrim;
  }

  function openMobileSidebar() {
    const sb = document.getElementById('novaSidebar');
    if (!sb) return;
    sb.classList.add('is-mobile-open');
    const scrim = ensureMobileScrim();
    scrim.classList.remove('is-hidden', 'hidden');
  }

  function closeMobileDrawers() {
    const sb = document.getElementById('novaSidebar');
    if (sb) sb.classList.remove('is-mobile-open');
    const scrim = document.getElementById('novaMobileScrim');
    if (scrim) scrim.classList.add('is-hidden', 'hidden');
  }

  function closeNovaPopupMenu() {
    const menu = document.getElementById('novaMobileTabs');
    if (menu) {
      menu.classList.add('hidden', 'is-hidden');
    }
    document.querySelectorAll('[data-nova-action="toggle-nova-menu"]').forEach((btn) => {
      btn.setAttribute('aria-expanded', 'false');
    });
  }

  function toggleNovaPopupMenu() {
    const menu = document.getElementById('novaMobileTabs');
    if (!menu) return;
    const isHidden = menu.classList.contains('hidden') || menu.classList.contains('is-hidden');
    if (isHidden) {
      menu.classList.remove('hidden', 'is-hidden');
      document.querySelectorAll('[data-nova-action="toggle-nova-menu"]').forEach((btn) => {
        btn.setAttribute('aria-expanded', 'true');
      });
    } else {
      closeNovaPopupMenu();
    }
  }

  function setMobileViewMode(mode) {
    document.documentElement.setAttribute('data-nova-mobile-view', mode);
  }

  function updateViewportLayout() {
    const root = document.documentElement;
    const stream = document.getElementById('novaMessagesStream');
    const savedScrollTop = stream ? stream.scrollTop : 0;

    if (isFoldUnfoldedViewport()) {
      root.setAttribute('data-nova-device', 'fold-unfolded');
      setMobileViewMode('split');
      closeMobileDrawers();
    } else if (window.innerWidth < 768) {
      root.setAttribute('data-nova-device', 'phone');
      const currentMode = root.getAttribute('data-nova-mobile-view');
      if (!currentMode || currentMode === 'split') {
        setMobileViewMode('chat');
      }
    } else {
      root.setAttribute('data-nova-device', 'desktop');
      setMobileViewMode('split');
      closeMobileDrawers();
    }

    if (stream && savedScrollTop > 0) {
      stream.scrollTop = savedScrollTop;
    }
  }

  function bindVisualViewportKeyboardPin() {
    if (!window.visualViewport) return;
    const vv = window.visualViewport;
    const onViewportChange = () => {
      const keyboardOffset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      document.documentElement.style.setProperty('--nova-kb-offset', `${Math.round(keyboardOffset)}px`);
      document.documentElement.style.setProperty('--nova-vvh', `${Math.round(vv.height)}px`);
    };
    vv.addEventListener('resize', onViewportChange);
    vv.addEventListener('scroll', onViewportChange);
    onViewportChange();
  }

  function bindTouchGestures() {
    let startX = 0;
    let startY = 0;
    let trackingEdgeSwipe = false;
    let trackingSidebarClose = false;
    let trackingInfoSwipeDown = false;

    document.addEventListener(
      'touchstart',
      (e) => {
        if (!e.touches || e.touches.length !== 1) return;
        const t = e.touches[0];
        startX = t.clientX;
        startY = t.clientY;

        const sb = document.getElementById('novaSidebar');
        const info = document.getElementById('novaInfoPane');

        trackingEdgeSwipe = startX <= 24 && isMobilePhoneViewport();
        trackingSidebarClose = Boolean(sb && sb.classList.contains('is-mobile-open'));
        trackingInfoSwipeDown = Boolean(
          info && !info.classList.contains('is-hidden') && info.contains(e.target) && info.scrollTop <= 4
        );
      },
      { passive: true }
    );

    document.addEventListener(
      'touchend',
      (e) => {
        if (!e.changedTouches || e.changedTouches.length !== 1) return;
        const t = e.changedTouches[0];
        const dx = t.clientX - startX;
        const dy = t.clientY - startY;

        if (trackingEdgeSwipe && dx >= 60 && Math.abs(dy) < 55) {
          openMobileSidebar();
        } else if (trackingSidebarClose && dx <= -60 && Math.abs(dy) < 55) {
          closeMobileDrawers();
        } else if (trackingInfoSwipeDown && dy >= 75 && Math.abs(dx) < 60) {
          const info = document.getElementById('novaInfoPane');
          if (info) info.classList.add('is-hidden');
        }

        trackingEdgeSwipe = false;
        trackingSidebarClose = false;
        trackingInfoSwipeDown = false;
      },
      { passive: true }
    );
  }

  function bindNovaMenuAndTabs() {
    document.addEventListener('click', (ev) => {
      const toggleBtn = ev.target.closest('[data-nova-action="toggle-nova-menu"]');
      if (toggleBtn) {
        ev.preventDefault();
        ev.stopPropagation();
        toggleNovaPopupMenu();
        return;
      }

      const closeMenuBtn = ev.target.closest('[data-nova-action="close-nova-menu"]');
      if (closeMenuBtn) {
        ev.preventDefault();
        closeNovaPopupMenu();
        return;
      }

      const menu = document.getElementById('novaMobileTabs');
      if (menu && !menu.classList.contains('hidden') && !menu.contains(ev.target)) {
        closeNovaPopupMenu();
      }

      // Clicking any agent/conversation row on mobile switches to active chat & closes drawer
      const row = ev.target.closest('.nova-agent-row, [data-conv-id], [data-conversation-id]');
      if (row && isMobilePhoneViewport()) {
        setMobileViewMode('chat');
        closeMobileDrawers();
      }

      // Menu item clicks (Chats, Computer, Routines, More)
      const tabBtn = ev.target.closest('[data-nova-mobile-tab]');
      if (tabBtn) {
        ev.preventDefault();
        const tab = tabBtn.getAttribute('data-nova-mobile-tab');
        closeNovaPopupMenu();

        const infoPane = document.getElementById('novaInfoPane');
        const moreSheet = document.getElementById('novaMobileMoreSheet');

        if (tab === 'chats') {
          if (moreSheet) moreSheet.classList.add('is-hidden', 'hidden');
          if (isMobilePhoneViewport()) {
            setMobileViewMode('list');
            openMobileSidebar();
          } else {
            const sb = document.getElementById('novaSidebar');
            if (sb) sb.classList.toggle('is-hidden');
          }
        } else if (tab === 'computer') {
          if (moreSheet) moreSheet.classList.add('is-hidden', 'hidden');
          closeMobileDrawers();
          if (infoPane) {
            infoPane.classList.remove('is-hidden');
            const compCard = document.getElementById('novaComputerCard');
            if (compCard) compCard.scrollIntoView({ behavior: 'smooth' });
          }
        } else if (tab === 'routines') {
          if (moreSheet) moreSheet.classList.add('is-hidden', 'hidden');
          closeMobileDrawers();
          if (infoPane) {
            infoPane.classList.remove('is-hidden');
            const routSec = document.getElementById('novaRoutinesList');
            if (routSec) routSec.scrollIntoView({ behavior: 'smooth' });
          }
        } else if (tab === 'more') {
          if (moreSheet) moreSheet.classList.remove('is-hidden', 'hidden');
        }
        return;
      }

      const closeMore = ev.target.closest('[data-nova-action="close-more-sheet"]');
      if (closeMore) {
        const moreSheet = document.getElementById('novaMobileMoreSheet');
        if (moreSheet) moreSheet.classList.add('is-hidden', 'hidden');
      }
    });

    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        closeNovaPopupMenu();
        const moreSheet = document.getElementById('novaMobileMoreSheet');
        if (moreSheet) moreSheet.classList.add('is-hidden', 'hidden');
      }
    });
  }

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(updateViewportLayout, 90);
  });

  document.addEventListener('DOMContentLoaded', () => {
    closeNovaPopupMenu();
    updateViewportLayout();
    bindVisualViewportKeyboardPin();
    bindTouchGestures();
    bindNovaMenuAndTabs();
  });

  window.NovaGestures = {
    openMobileSidebar,
    closeMobileDrawers,
    closeNovaPopupMenu,
    toggleNovaPopupMenu,
    setMobileViewMode,
    updateViewportLayout
  };
})();
