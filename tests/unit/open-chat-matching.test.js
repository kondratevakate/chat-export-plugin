/**
 * open-chat-matching.test.js — Regression for the "Could not find chat ...
 * Skipping" mass-failure on WhatsApp.
 *
 * Root cause was a strict equality match between chatKeyToName(slug) and the
 * candidate's textContent, which:
 *   1. Failed on truncated UI labels ("Sara Mubara…")
 *   2. Failed when the textContent included a status badge or nested text
 *   3. Did not handle multiple span[title] elements per item
 *
 * Extractor.matchesChatName centralises the new fuzzy-matching rules; if any
 * of these tests fail, openChat will start skipping chats again.
 */

import { describe, test, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { loadScriptCJS } from '../helpers/load-script.js';

const { Extractor } = loadScriptCJS('utils/extractor.js');

describe('Extractor.matchesChatName', () => {
  test('exact match (case-insensitive)', () => {
    expect(Extractor.matchesChatName(['Effie Guo'], 'effie guo')).toBe(true);
  });

  test('candidate contains target (status badge wraps the title)', () => {
    expect(Extractor.matchesChatName(['Effie Guo · Online'], 'Effie Guo')).toBe(true);
  });

  test('target contains candidate (UI truncation)', () => {
    // The chat list shows "Sara Mubara…" but the canonical name is longer.
    expect(Extractor.matchesChatName(['Sara Mubara'], 'Sara Mubara Project Managers Dubai Health'))
      .toBe(true);
  });

  test('rejects too-short candidate to avoid false positives', () => {
    // A 2-character candidate that happens to be inside the target
    // should NOT match (would otherwise wildcard everything).
    expect(Extractor.matchesChatName(['Sa'], 'Sara Mubara')).toBe(false);
  });

  test('handles whitespace and case variation', () => {
    expect(Extractor.matchesChatName(['  EFFIE   GUO  '], 'effie guo')).toBe(true);
  });

  test('returns false on empty / falsy input', () => {
    expect(Extractor.matchesChatName([], 'Effie')).toBe(false);
    expect(Extractor.matchesChatName(['Effie'], '')).toBe(false);
    expect(Extractor.matchesChatName(['', null, undefined], 'Effie')).toBe(false);
  });

  test('multiple candidates — any single match wins', () => {
    const candidates = ['', 'unrelated tag', null, 'Effie Guo'];
    expect(Extractor.matchesChatName(candidates, 'Effie Guo')).toBe(true);
  });
});

describe('openChat name matching against fixture DOM', () => {
  test('finds chat in WhatsApp-style item with span[title] + nested span[dir]', () => {
    const dom = new JSDOM(`
      <div role="listitem">
        <span title="Effie Guo" dir="auto"><span dir="auto">Effie Guo</span></span>
        <span dir="ltr">last preview text</span>
      </div>
    `);
    const item = dom.window.document.querySelector('[role="listitem"]');
    const candidates = [];
    item.querySelectorAll('span[title]').forEach((el) => {
      candidates.push(el.getAttribute('title'));
      candidates.push(el.textContent);
    });
    item.querySelectorAll('span[dir="auto"]').forEach((el) => candidates.push(el.textContent));
    expect(Extractor.matchesChatName(candidates, 'Effie Guo')).toBe(true);
  });

  test('rejects unrelated item', () => {
    const dom = new JSDOM(`
      <div role="listitem">
        <span title="Atelic - AMR Review">Atelic - AMR Review</span>
      </div>
    `);
    const item = dom.window.document.querySelector('[role="listitem"]');
    const candidates = Array.from(item.querySelectorAll('span[title]'))
      .flatMap((el) => [el.getAttribute('title'), el.textContent]);
    expect(Extractor.matchesChatName(candidates, 'Effie Guo')).toBe(false);
  });

  test('regression: phone-number chats with special chars in displayName', () => {
    // displayName: "+971 56 617 8030"  →  chatKey via Extractor.buildChatKey:
    const displayName = '+971 56 617 8030';
    const chatKey = Extractor.buildChatKey({ displayName });
    expect(chatKey).toBe('chat_+971_56_617_8030');

    const dom = new JSDOM(`
      <div role="listitem">
        <span title="+971 56 617 8030">+971 56 617 8030</span>
      </div>
    `);
    const item = dom.window.document.querySelector('[role="listitem"]');
    const candidates = Array.from(item.querySelectorAll('span[title]'))
      .flatMap((el) => [el.getAttribute('title'), el.textContent]);

    // Critical: matching by the original displayName must work, even though
    // the chatKey embeds a literal '+'.
    expect(Extractor.matchesChatName(candidates, displayName)).toBe(true);
  });
});
