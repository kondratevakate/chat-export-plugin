import { describe, test, expect } from 'vitest';
import { loadScriptCJS } from '../helpers/load-script.js';

const { Logger } = loadScriptCJS('utils/logger.js');

describe('Logger.formatLine', () => {
  test('produces the canonical format: "HH:MM:SS [src][level] action key=val"', () => {
    const line = Logger.formatLine({
      ts: '12:34:56',
      src: 'sw',
      level: 'info',
      action: 'scanInbox.done',
      data: { count: 42, dedupedFrom: 45 },
    });
    expect(line).toBe('12:34:56 [sw][info] scanInbox.done count=42 dedupedFrom=45');
  });

  test('handles missing data gracefully', () => {
    const line = Logger.formatLine({
      ts: '00:00:00',
      src: 'cs',
      level: 'warn',
      action: 'abort.signaled',
    });
    expect(line).toBe('00:00:00 [cs][warn] abort.signaled');
  });

  test('skips undefined and null fields', () => {
    const line = Logger.formatLine({
      ts: '00:00:00',
      src: 'sw',
      level: 'info',
      action: 'x',
      data: { a: 1, b: undefined, c: null, d: 'hi' },
    });
    expect(line).toBe('00:00:00 [sw][info] x a=1 d=hi');
  });

  test('JSON-stringifies non-string values', () => {
    const line = Logger.formatLine({
      ts: '00:00:00',
      src: 'sw',
      level: 'info',
      action: 'x',
      data: { arr: [1, 2], obj: { k: 'v' } },
    });
    expect(line).toContain('arr=[1,2]');
    expect(line).toContain('obj={"k":"v"}');
  });
});

describe('Logger.makeBuffer ring cap', () => {
  test('rolls when push exceeds max', () => {
    const buf = Logger.makeBuffer(5);
    for (let i = 0; i < 12; i++) buf.push(`line-${i}`);
    expect(buf.size()).toBe(5);
    expect(buf.lines()).toEqual(['line-7', 'line-8', 'line-9', 'line-10', 'line-11']);
  });

  test('clear empties the buffer', () => {
    const buf = Logger.makeBuffer(10);
    buf.push('a'); buf.push('b');
    buf.clear();
    expect(buf.size()).toBe(0);
    expect(buf.lines()).toEqual([]);
  });

  test('replaceAll respects the cap', () => {
    const buf = Logger.makeBuffer(3);
    buf.replaceAll(['1', '2', '3', '4', '5']);
    expect(buf.lines()).toEqual(['3', '4', '5']);
  });
});

describe('Logger PII safety', () => {
  test('does NOT mention common message-text patterns by accident', () => {
    // Smoke test: the logger formats {chatKey, count} — never the raw text.
    const line = Logger.formatLine({
      ts: '00:00:00',
      src: 'cs',
      level: 'info',
      action: 'extractChat.collected',
      data: { chatKey: 'abc-123', total: 17, returned: 17 },
    });
    expect(line).not.toMatch(/text|message body|displayName/i);
  });

  test('listener can mirror lines for UI without leaking entry shape', () => {
    const seen = [];
    const off = Logger.onLine((line) => seen.push(line));
    const log = Logger.logFor('ui');
    log.info('test.event', { count: 1 });
    off();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/\[ui\]\[info\] test\.event count=1/);
  });
});
