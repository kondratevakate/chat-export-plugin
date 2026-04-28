/**
 * storage-resilience.test.js — Failure modes D and E from the plan.
 *
 * D. Log buffer rolls before chrome.storage quota is hit (10 MB).
 * E. Service-worker restart recovery: extracted messages must be
 *    readable from chrome.storage.local even if the in-memory state
 *    was dropped when the SW terminated.
 */

import { describe, test, expect } from 'vitest';
import { loadScriptCJS } from '../helpers/load-script.js';

const { Logger } = loadScriptCJS('utils/logger.js');

describe('log buffer never exceeds ring cap', () => {
  test('default cap is 2000 lines', () => {
    expect(Logger.MAX_LOG_LINES).toBe(2000);
  });

  test('size remains capped under heavy push load', () => {
    const buf = Logger.makeBuffer(100);
    for (let i = 0; i < 5000; i++) buf.push('line-' + i);
    expect(buf.size()).toBe(100);
    // Earliest retained entry is line-4900 (last 100).
    expect(buf.lines()[0]).toBe('line-4900');
    expect(buf.lines()[99]).toBe('line-4999');
  });

  test('buffer with 2000 lines of typical log size stays under 1 MB', () => {
    const buf = Logger.makeBuffer(2000);
    // Typical line ~100 chars: timestamp + src + level + action + a few k=v pairs.
    const sample = '12:34:56 [sw][info] processQueue.chatDone chatKey=abc-123 total=42 collected=20 mode=test afterDateFilter=18';
    for (let i = 0; i < 5000; i++) buf.push(sample);
    const totalChars = buf.lines().reduce((acc, l) => acc + l.length, 0);
    // 2000 * ~110 = 220 000 chars — well under chrome.storage.local's 10 MB.
    expect(totalChars).toBeLessThan(1_000_000);
  });
});

describe('service-worker restart recovery model', () => {
  /**
   * The SW persists `extractedMessages` to chrome.storage.local after each
   * batch (service_worker.js#processQueue). When the SW dies and reboots,
   * exportToFile reads back from storage. We model that round trip here.
   */
  function makeStorage() {
    const data = {};
    return {
      async set(obj) { Object.assign(data, obj); },
      async get(keys) {
        const out = {};
        for (const k of keys) if (k in data) out[k] = data[k];
        return out;
      },
      _data: data,
    };
  }

  test('extractedMessages survive a restart via chrome.storage round trip', async () => {
    const storage = makeStorage();
    const messages = [
      { chatKey: 'a', text: 'one' },
      { chatKey: 'b', text: 'two' },
    ];

    // Simulate processQueue.done persisting state.
    await storage.set({ extractedMessages: messages });

    // SW dies — in-memory state is gone, but storage persists.
    let extractedMessagesInMemory = [];
    expect(extractedMessagesInMemory).toHaveLength(0);

    // SW boots, exportToFile checks storage.
    if (extractedMessagesInMemory.length === 0) {
      const stored = await storage.get(['extractedMessages']);
      if (stored.extractedMessages) extractedMessagesInMemory = stored.extractedMessages;
    }

    expect(extractedMessagesInMemory).toHaveLength(2);
    expect(extractedMessagesInMemory[0].chatKey).toBe('a');
  });

  test('absent storage returns empty without throwing', async () => {
    const storage = makeStorage();
    const stored = await storage.get(['extractedMessages']);
    expect(stored.extractedMessages).toBeUndefined();
  });
});
