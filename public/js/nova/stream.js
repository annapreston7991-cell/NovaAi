/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
/**
 * Nova SSE Client Stream & Fallback Poller (§11.3)
 */
(function () {
  class NovaStreamClient {
    constructor(handlers = {}) {
      this.handlers = handlers;
      this.es = null;
      this.lastEventId = null;
      this.pollTimer = null;
    }

    connect() {
      this.close();
      if (typeof window.EventSource === 'undefined') {
        this.startFallbackPolling();
        return;
      }

      const url = this.lastEventId
        ? `/api/nova/stream?lastEventId=${encodeURIComponent(this.lastEventId)}`
        : '/api/nova/stream';

      const es = new EventSource(url, { withCredentials: true });
      this.es = es;

      const bindEvent = (eventName) => {
        es.addEventListener(eventName, (ev) => {
          if (ev.lastEventId) this.lastEventId = ev.lastEventId;
          let parsed = {};
          try { parsed = JSON.parse(ev.data || '{}'); } catch (e) {}
          if (this.handlers[eventName]) {
            this.handlers[eventName](parsed, ev);
          }
        });
      };

      [
        'connected',
        'message.created',
        'message.delta',
        'message.updated',
        'job.status',
        'reaction',
        'widget.answered',
        'unread',
        'nova.stopped',
        'ping'
      ].forEach(bindEvent);

      es.onerror = () => {
        // Browser EventSource auto-reconnects; also run a light poll if disconnected
        this.startFallbackPolling();
      };

      es.onopen = () => {
        this.stopFallbackPolling();
      };
    }

    startFallbackPolling() {
      if (this.pollTimer) return;
      this.pollTimer = setInterval(() => {
        if (this.handlers.onFallbackPoll) {
          this.handlers.onFallbackPoll();
        }
      }, 5000);
    }

    stopFallbackPolling() {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
    }

    close() {
      this.stopFallbackPolling();
      if (this.es) {
        try { this.es.close(); } catch (e) {}
        this.es = null;
      }
    }
  }

  window.NovaStreamClient = NovaStreamClient;
})();
