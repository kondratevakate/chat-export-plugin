/**
 * logger.js — Structured logger shared by service worker, content script, and side panel.
 *
 * Output format: "HH:MM:SS [src][level] action key1=val1 key2=val2"
 * Sources: 'sw' (service worker), 'cs' (content script), 'ui' (side panel).
 * Levels:  'info' | 'warn' | 'error'.
 *
 * PII rule (global CLAUDE.md): logs contain only IDs and selector counts —
 * never message text, displayName values, or contact names. Pass `chatKey`
 * (URL-derived id) instead of `displayName`.
 *
 * Loaded as a classic script in browser contexts (globalThis.Logger) and as
 * a CommonJS module in Node test runners (module.exports.Logger).
 */

(function (globalScope) {
  'use strict';

  const MAX_LOG_LINES = 2000; // ring buffer cap to stay under chrome.storage quota

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function timestamp() {
    const d = new Date();
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function formatData(data) {
    if (!data) return '';
    const parts = [];
    for (const k of Object.keys(data)) {
      const v = data[k];
      if (v === undefined || v === null) continue;
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      parts.push(k + '=' + s);
    }
    return parts.length ? ' ' + parts.join(' ') : '';
  }

  function formatLine(entry) {
    return (entry.ts || timestamp()) +
      ' [' + entry.src + '][' + entry.level + '] ' +
      entry.action +
      formatData(entry.data);
  }

  function makeBuffer(max) {
    const lines = [];
    return {
      push(line) {
        lines.push(line);
        if (lines.length > max) lines.splice(0, lines.length - max);
      },
      lines() { return lines.slice(); },
      clear() { lines.length = 0; },
      size() { return lines.length; },
      replaceAll(arr) {
        lines.length = 0;
        const start = Math.max(0, arr.length - max);
        for (let i = start; i < arr.length; i++) lines.push(arr[i]);
      },
    };
  }

  // Module-level singleton buffer per execution context.
  const buffer = makeBuffer(MAX_LOG_LINES);

  // Optional listeners — sidepanel attaches one to mirror lines into the DOM.
  const listeners = [];

  function emit(entry) {
    const line = formatLine(entry);
    buffer.push(line);

    // Mirror to console at the matching level
    const consoleMethod = entry.level === 'error' ? 'error' : entry.level === 'warn' ? 'warn' : 'log';
    if (typeof console !== 'undefined' && console[consoleMethod]) {
      console[consoleMethod]('[' + entry.src + '] ' + entry.action + formatData(entry.data));
    }

    for (const fn of listeners) {
      try { fn(line, entry); } catch (_) { /* ignore listener errors */ }
    }
  }

  function logFor(src) {
    function build(level) {
      return function (action, data) {
        emit({ ts: timestamp(), src: src, level: level, action: action, data: data });
      };
    }
    return { info: build('info'), warn: build('warn'), error: build('error') };
  }

  function onLine(fn) {
    listeners.push(fn);
    return function unsubscribe() {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  const Logger = {
    logFor: logFor,
    formatLine: formatLine,
    formatData: formatData,
    buffer: buffer,
    onLine: onLine,
    MAX_LOG_LINES: MAX_LOG_LINES,
    // Test helper — exposed so tests can build their own isolated buffer.
    makeBuffer: makeBuffer,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { Logger: Logger };
  }
  if (globalScope) {
    globalScope.Logger = Logger;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
