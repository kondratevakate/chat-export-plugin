import { describe, test, expect } from 'vitest';
import { loadScriptCJS } from '../helpers/load-script.js';

const { Extractor } = loadScriptCJS('utils/extractor.js');

describe('Extractor.dedupeChats', () => {
  test('drops duplicates by chatKey, preserves first-seen order', () => {
    const input = [
      { chatKey: 'a', displayName: 'Alice' },
      { chatKey: 'b', displayName: 'Bob' },
      { chatKey: 'a', displayName: 'Alice (pinned)' }, // duplicate
      { chatKey: 'c', displayName: 'Carol' },
      { chatKey: 'b', displayName: 'Bob (again)' },    // duplicate
    ];
    const { chats, droppedDuplicates } = Extractor.dedupeChats(input);
    expect(chats.map(c => c.chatKey)).toEqual(['a', 'b', 'c']);
    expect(droppedDuplicates).toBe(2);
    // First-seen wins — preserves the displayName from the first occurrence.
    expect(chats[0].displayName).toBe('Alice');
    expect(chats[1].displayName).toBe('Bob');
  });

  test('skips entries without chatKey', () => {
    const { chats, droppedDuplicates } = Extractor.dedupeChats([
      { chatKey: 'a' },
      { chatKey: '' },
      null,
      undefined,
      { displayName: 'no key' },
      { chatKey: 'a' }, // dup
    ]);
    expect(chats).toHaveLength(1);
    expect(droppedDuplicates).toBe(1);
  });

  test('handles empty input', () => {
    const { chats, droppedDuplicates } = Extractor.dedupeChats([]);
    expect(chats).toEqual([]);
    expect(droppedDuplicates).toBe(0);
  });
});

describe('Extractor.selectMessagesForMode', () => {
  const make = (n) => Array.from({ length: n }, (_, i) => ({ idx: i, text: `m${i}` }));

  test('test mode returns the LAST 20 (most recent for chronological-bottom DOMs)', () => {
    const result = Extractor.selectMessagesForMode(make(50), 'test');
    expect(result).toHaveLength(20);
    expect(result[0].idx).toBe(30);
    expect(result[19].idx).toBe(49);
  });

  test('test mode honours custom testLimit', () => {
    const result = Extractor.selectMessagesForMode(make(50), 'test', { testLimit: 5 });
    expect(result).toHaveLength(5);
    expect(result.map(m => m.idx)).toEqual([45, 46, 47, 48, 49]);
  });

  test('test mode returns everything when fewer than limit', () => {
    const result = Extractor.selectMessagesForMode(make(7), 'test');
    expect(result).toHaveLength(7);
  });

  test('full mode returns all messages, regardless of count', () => {
    const result = Extractor.selectMessagesForMode(make(200), 'full');
    expect(result).toHaveLength(200);
  });

  test('full mode is a copy, not the original array', () => {
    const input = make(3);
    const result = Extractor.selectMessagesForMode(input, 'full');
    expect(result).not.toBe(input);
    expect(result).toEqual(input);
  });

  test('unknown mode falls back to test (defensive)', () => {
    const result = Extractor.selectMessagesForMode(make(50), 'wat');
    expect(result).toHaveLength(20);
  });

  test('regression: does NOT filter by senderName (the old bug)', () => {
    const messages = [
      { sender: 'Kate Kondrateva', text: 'a' },
      { sender: 'Bob', text: 'b' },
      { sender: 'Carol', text: 'c' },
    ];
    const result = Extractor.selectMessagesForMode(messages, 'test');
    expect(result.map(m => m.sender)).toEqual(['Kate Kondrateva', 'Bob', 'Carol']);
  });
});

describe('Extractor.takeMostRecentByTimestamp', () => {
  test('sorts by date descending, picks N', () => {
    const msgs = [
      { messageDateRaw: '2024-01-05T00:00:00Z', text: 'a' },
      { messageDateRaw: '2024-01-10T00:00:00Z', text: 'b' },
      { messageDateRaw: '2024-01-01T00:00:00Z', text: 'c' },
      { messageDateRaw: '2024-01-15T00:00:00Z', text: 'd' },
    ];
    const result = Extractor.takeMostRecentByTimestamp(msgs, 2);
    expect(result.map(m => m.text)).toEqual(['d', 'b']);
  });

  test('handles undated messages by treating ts=0 (pushed to bottom)', () => {
    const msgs = [
      { messageDateRaw: 'not a date', text: 'undated' },
      { messageDateRaw: '2024-01-01T00:00:00Z', text: 'dated' },
    ];
    const result = Extractor.takeMostRecentByTimestamp(msgs, 2);
    expect(result[0].text).toBe('dated');
    expect(result[1].text).toBe('undated');
  });
});

describe('Extractor.buildChatKey', () => {
  test('extracts thread id from LinkedIn messaging URL', () => {
    expect(Extractor.buildChatKey({ href: 'https://www.linkedin.com/messaging/thread/abc-123/' }))
      .toBe('abc-123');
  });

  test('extracts inbox id from Sales Navigator URL', () => {
    expect(Extractor.buildChatKey({ href: 'https://www.linkedin.com/sales/inbox/xyz-9' }))
      .toBe('xyz-9');
  });

  test('falls back to display-name slug when no href', () => {
    expect(Extractor.buildChatKey({ displayName: 'Effie Guo' }))
      .toBe('chat_effie_guo');
  });

  test('returns href verbatim when pattern does not match', () => {
    expect(Extractor.buildChatKey({ href: 'https://example.com/foo' }))
      .toBe('https://example.com/foo');
  });
});

describe('Extractor.safeForLog', () => {
  test('redacts emails', () => {
    expect(Extractor.safeForLog('contact me at jane@example.com please'))
      .toBe('contact me at <email> please');
  });

  test('redacts phone numbers', () => {
    expect(Extractor.safeForLog('call +971 56 617 8030 today'))
      .toContain('<phone>');
    expect(Extractor.safeForLog('call +971 56 617 8030 today'))
      .not.toContain('8030');
  });

  test('handles empty / null input', () => {
    expect(Extractor.safeForLog('')).toBe('');
    expect(Extractor.safeForLog(null)).toBe('');
    expect(Extractor.safeForLog(undefined)).toBe('');
  });
});
