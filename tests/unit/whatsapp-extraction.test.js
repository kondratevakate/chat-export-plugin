/**
 * whatsapp-extraction.test.js — Verifies that the WhatsApp-specific message
 * extraction correctly parses sender + timestamp from data-pre-plain-text.
 *
 * Failure mode: WhatsApp ships a class change (already happened in 2024 with
 * the removal of `.selectable-text`) and the body selector returns 0. This
 * test pins the new behaviour to selectors.js + the in-script extraction.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(
  resolve(__dirname, '..', 'fixtures', 'whatsapp-pane-side_2026-04-28.html'),
  'utf8'
);

/**
 * Mirror of content_script.js#collectMessagesWhatsapp, isolated for tests.
 * Keep this in sync with the production implementation.
 */
function collectMessagesWhatsapp(document, senderName, contactName, chatKey) {
  const cleanText = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const messages = [];
  const messageEls = document.querySelectorAll('#main div.message-in, #main div.message-out');
  for (const el of messageEls) {
    const isMine = el.classList.contains('message-out');
    const meta = el.querySelector('[data-pre-plain-text]');
    const preText = meta ? meta.getAttribute('data-pre-plain-text') || '' : '';
    let timestamp = '';
    let parsedSender = '';
    const m = preText.match(/^\[([^\]]+)\]\s*([^:]*):\s*$/);
    if (m) {
      timestamp = m[1].trim();
      parsedSender = cleanText(m[2]);
    }
    let bodyEl = el.querySelector('span.copyable-text') || meta;
    const text = cleanText(bodyEl?.textContent);
    if (!text) continue;
    const finalSender = isMine
      ? senderName
      : (parsedSender && parsedSender.toLowerCase() !== 'you' ? parsedSender : contactName);
    messages.push({
      messageDateRaw: timestamp,
      sender: finalSender,
      receiver: isMine ? contactName : senderName,
      text,
      chatKey,
    });
  }
  return messages;
}

describe('WhatsApp message extraction', () => {
  let document;
  beforeEach(() => {
    document = new JSDOM(fixture).window.document;
  });

  test('finds 2 messages in the fixture (was 0 before fix)', () => {
    const out = collectMessagesWhatsapp(document, 'Kate', 'Effie Guo', 'effie-guo');
    expect(out.length).toBe(2);
  });

  test('parses sender from data-pre-plain-text for incoming messages', () => {
    const out = collectMessagesWhatsapp(document, 'Kate', 'Effie Guo', 'effie-guo');
    const incoming = out.find((m) => m.text.includes('still on for tomorrow'));
    expect(incoming.sender).toBe('Effie Guo');
    expect(incoming.receiver).toBe('Kate');
    expect(incoming.messageDateRaw).toBe('12:34, 5/4/2024');
  });

  test('detects own messages (message-out) and labels sender accordingly', () => {
    const out = collectMessagesWhatsapp(document, 'Kate', 'Effie Guo', 'effie-guo');
    const outgoing = out.find((m) => m.text.includes('see you then'));
    expect(outgoing.sender).toBe('Kate');
    expect(outgoing.receiver).toBe('Effie Guo');
    expect(outgoing.messageDateRaw).toBe('12:35, 5/4/2024');
  });

  test('does NOT pick up chat-list rows in #pane-side as messages', () => {
    const out = collectMessagesWhatsapp(document, 'Kate', 'Effie Guo', 'effie-guo');
    expect(out.every((m) => !m.text.includes('Yesterday'))).toBe(true);
    expect(out.every((m) => !m.text.includes('Photo'))).toBe(true);
  });
});

