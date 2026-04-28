/**
 * extractor.js — Pure logic shared by content_script.js and tests.
 *
 * No DOM access here directly — receives already-queried elements / arrays
 * and returns transformed data. This is the testable surface; everything
 * DOM-y stays in content_script.js.
 *
 * Loaded as classic script in browser (globalThis.Extractor) and as
 * CommonJS module under Node test runner.
 */

(function (globalScope) {
  'use strict';

  /**
   * Deduplicate scanned chats by chatKey, preserving first-seen order.
   * @param {Array<{chatKey: string}>} chats
   * @returns {{chats: Array, droppedDuplicates: number}}
   */
  function dedupeChats(chats) {
    const seen = new Set();
    const out = [];
    let dropped = 0;
    for (const c of chats) {
      if (!c || !c.chatKey) continue;
      if (seen.has(c.chatKey)) { dropped++; continue; }
      seen.add(c.chatKey);
      out.push(c);
    }
    return { chats: out, droppedDuplicates: dropped };
  }

  /**
   * Apply extraction-mode policy to the raw collected messages.
   *
   *  mode === 'test' → return the last 20 (most recent, since DOM order is
   *                    chronological newest-at-bottom on supported platforms).
   *                    Sender filtering is NOT applied.
   *  mode === 'full' → return everything; date-range filtering happens later
   *                    in the service worker against settings.dateFrom/dateTo.
   *
   * Anything else falls back to 'test' (defensive default).
   *
   * @param {Array} messages          raw messages collected from DOM
   * @param {string} mode             'test' | 'full'
   * @param {object} [opts]           { testLimit?: number = 20 }
   * @returns {Array}
   */
  function selectMessagesForMode(messages, mode, opts) {
    const safeMode = mode === 'full' ? 'full' : 'test';
    if (safeMode === 'full') return messages.slice();
    const limit = (opts && typeof opts.testLimit === 'number') ? opts.testLimit : 20;
    if (messages.length <= limit) return messages.slice();
    return messages.slice(messages.length - limit);
  }

  /**
   * Sort messages by parsed timestamp descending and take the first N.
   * Use this as a fallback when DOM order is not reliably chronological.
   *
   * @param {Array} messages
   * @param {number} limit
   * @returns {Array}
   */
  function takeMostRecentByTimestamp(messages, limit) {
    const dated = messages.map(function (m, i) {
      const d = m && m.messageDateRaw ? new Date(m.messageDateRaw) : null;
      const ts = d && !isNaN(d.getTime()) ? d.getTime() : 0;
      return { msg: m, ts: ts, originalIndex: i };
    });
    // Most recent first; stable on ties via original index.
    dated.sort(function (a, b) {
      if (b.ts !== a.ts) return b.ts - a.ts;
      return b.originalIndex - a.originalIndex;
    });
    return dated.slice(0, limit).map(function (x) { return x.msg; });
  }

  /**
   * Build a stable chatKey from a chat-list item's link href and display name.
   *
   * Mirrors the existing logic in content_script.js#parseChatItem so
   * dedupe keys agree between scan-time and runtime.
   *
   * @param {{href?: string, displayName?: string}} input
   * @returns {string}
   */
  function buildChatKey(input) {
    if (input && input.href) {
      const m = input.href.match(/(?:thread|inbox)\/([^/?\s]+)/);
      if (m) return m[1];
      return input.href;
    }
    if (input && input.displayName) {
      return 'chat_' + String(input.displayName).replace(/\s+/g, '_').toLowerCase();
    }
    return '';
  }

  /**
   * Returns true if any of `candidates` (chat-item label strings) plausibly
   * refers to the same chat as `target`. Used by openChat to find a chat in
   * a virtualised list without depending on stable hrefs.
   *
   * Match rules (case-insensitive, whitespace-normalised):
   *   - exact equality
   *   - candidate contains target (handles wrapping with a status badge)
   *   - target contains candidate (handles UI truncation: "Sara Mubara…")
   *
   * @param {string[]} candidates
   * @param {string} target
   * @returns {boolean}
   */
  function matchesChatName(candidates, target) {
    if (!target) return false;
    const t = String(target).replace(/\s+/g, ' ').trim().toLowerCase();
    if (!t) return false;
    for (const raw of candidates) {
      if (!raw) continue;
      const c = String(raw).replace(/\s+/g, ' ').trim().toLowerCase();
      if (!c) continue;
      if (c === t) return true;
      if (c.includes(t)) return true;
      if (t.includes(c) && c.length >= 3) return true;
    }
    return false;
  }

  /**
   * Scrub a log line / progress message of values that look like they could be
   * personally identifying — keep only chatKey-like ids.
   *
   * Used as a safety net for free-form strings that flow into log files.
   *
   * @param {string} text
   * @returns {string}
   */
  function safeForLog(text) {
    if (!text) return '';
    // Drop anything that looks like an email or phone number.
    return String(text)
      .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '<email>')
      .replace(/\+?\d[\d\s().-]{6,}\d/g, '<phone>');
  }

  const Extractor = {
    dedupeChats: dedupeChats,
    selectMessagesForMode: selectMessagesForMode,
    takeMostRecentByTimestamp: takeMostRecentByTimestamp,
    buildChatKey: buildChatKey,
    matchesChatName: matchesChatName,
    safeForLog: safeForLog,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { Extractor: Extractor };
  }
  if (globalScope) {
    globalScope.Extractor = Extractor;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
