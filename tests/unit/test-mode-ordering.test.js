/**
 * test-mode-ordering.test.js — Failure mode C from the plan.
 *
 * "Last 20" assumes the platform renders messages in chronological order with
 * the newest at the bottom (true today for WhatsApp / LinkedIn / Sales Nav).
 * If a future platform reverses it, takeMostRecentByTimestamp is the fallback
 * — these tests pin its semantics so a regression is caught at CI.
 */

import { describe, test, expect } from 'vitest';
import { loadScriptCJS } from '../helpers/load-script.js';

const { Extractor } = loadScriptCJS('utils/extractor.js');

describe('takeMostRecentByTimestamp picks newest regardless of input order', () => {
  test('input in random order — output is descending by date', () => {
    const messages = [
      { messageDateRaw: '2024-03-15T12:00:00Z', text: 'mar15' },
      { messageDateRaw: '2024-01-01T00:00:00Z', text: 'jan01' },
      { messageDateRaw: '2024-12-31T23:00:00Z', text: 'dec31' },
      { messageDateRaw: '2024-06-01T00:00:00Z', text: 'jun01' },
    ];
    const result = Extractor.takeMostRecentByTimestamp(messages, 3);
    expect(result.map((m) => m.text)).toEqual(['dec31', 'jun01', 'mar15']);
  });

  test('stable on ties — preserves original order for equal timestamps', () => {
    const sameDate = '2024-01-01T00:00:00Z';
    const messages = [
      { messageDateRaw: sameDate, text: 'first' },
      { messageDateRaw: sameDate, text: 'second' },
      { messageDateRaw: sameDate, text: 'third' },
    ];
    const result = Extractor.takeMostRecentByTimestamp(messages, 2);
    expect(result.length).toBe(2);
    // Stable sort: when ts equal, last-encountered (highest originalIndex) wins.
    expect(result[0].text).toBe('third');
    expect(result[1].text).toBe('second');
  });
});

describe('selectMessagesForMode test-mode is order-preserving', () => {
  test('returns the LAST 20 in DOM order (slice from tail)', () => {
    const messages = [];
    for (let i = 0; i < 30; i++) {
      messages.push({ idx: i, messageDateRaw: `2024-01-${String(i + 1).padStart(2, '0')}T00:00:00Z` });
    }
    const result = Extractor.selectMessagesForMode(messages, 'test');
    expect(result.length).toBe(20);
    expect(result[0].idx).toBe(10);
    expect(result[19].idx).toBe(29);
  });

  test('regression: last 20 are the most recent (chronological-bottom assumption)', () => {
    // Build messages in chronological order (oldest first → newest last).
    const messages = [];
    for (let i = 0; i < 100; i++) {
      const day = String(i + 1).padStart(2, '0');
      messages.push({ messageDateRaw: `2024-01-${day === '00' ? '01' : day}T00:00:00Z`, idx: i });
    }
    const result = Extractor.selectMessagesForMode(messages, 'test');
    // The last 20 by index ARE the 20 with the highest dates.
    const dates = result.map((m) => new Date(m.messageDateRaw).getTime()).sort((a, b) => a - b);
    const allDates = messages.map((m) => new Date(m.messageDateRaw).getTime()).sort((a, b) => a - b);
    const topByDate = allDates.slice(-20);
    expect(dates).toEqual(topByDate);
  });
});
