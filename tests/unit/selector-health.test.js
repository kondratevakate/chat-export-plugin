/**
 * selector-health.test.js — Canary for DOM selector rot.
 *
 * For each platform fixture the conversation-list selectors must match ≥1
 * element. When a platform ships a DOM change that breaks scanning, this
 * test fails BEFORE users see "0 chats found" in production.
 *
 * Failure mode A from the plan ("DOM selector rot").
 */

import { describe, test, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { loadScriptCJS } from '../helpers/load-script.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, '..', 'fixtures');

let PLATFORM_SELECTORS;

beforeAll(() => {
  ({ PLATFORM_SELECTORS } = loadScriptCJS('selectors.js'));
});

const platforms = [
  { id: 'whatsapp', file: 'whatsapp-pane-side_2026-04-28.html' },
  { id: 'sales_navigator', file: 'sales-navigator-list_2026-04-28.html' },
  { id: 'linkedin', file: 'linkedin-list_2026-04-28.html' },
];

// Selectors the chat-list scan needs. These MUST match in the fixture; if
// the platform changes, the fixture must be updated.
const REQUIRED_SCAN_SELECTORS = [
  'conversationList',
  'conversationItem',
  'conversationItemName',
  'conversationItemLink',
];

describe.each(platforms)('selector health — $id', ({ id, file }) => {
  let document;

  beforeAll(() => {
    const html = readFileSync(resolve(fixturesDir, file), 'utf8');
    document = new JSDOM(html).window.document;
  });

  test.each(REQUIRED_SCAN_SELECTORS)('%s matches at least one element', (key) => {
    const pair = PLATFORM_SELECTORS[id][key];
    const primary = document.querySelectorAll(pair.primary).length;
    const fallback = pair.fallback ? document.querySelectorAll(pair.fallback).length : 0;
    if (primary + fallback === 0) {
      throw new Error(
        `[${id}] selector "${key}" matched 0 elements.\n` +
        `  primary:  ${pair.primary}\n` +
        `  fallback: ${pair.fallback}\n` +
        `Likely: platform DOM changed. Re-capture fixture and update selectors.js.`
      );
    }
    expect(primary + fallback).toBeGreaterThan(0);
  });
});

describe('WhatsApp scoping regression', () => {
  let document;

  beforeAll(() => {
    const html = readFileSync(
      resolve(fixturesDir, 'whatsapp-pane-side_2026-04-28.html'),
      'utf8'
    );
    document = new JSDOM(html).window.document;
  });

  test('conversationItem is scoped to #pane-side and ignores chat-area listitems', () => {
    const pair = PLATFORM_SELECTORS.whatsapp.conversationItem;
    const items = document.querySelectorAll(pair.primary);
    expect(items.length).toBe(3); // 3 chats in fixture, NOT 4 (the 4th is in #main)

    // Sanity: every match must be inside #pane-side.
    items.forEach((el) => {
      const closest = el.closest('#pane-side');
      expect(closest).not.toBeNull();
    });
  });
});
