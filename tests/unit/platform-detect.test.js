/**
 * platform-detect.test.js — URL-based platform detection.
 *
 * The service worker uses detectPlatformFromUrl() to know what's loaded in
 * the active tab without relying on `location` (it has none). The side panel
 * uses the result to show "WhatsApp Web detected" or "this page is not yet
 * supported" — getting this wrong means a misleading banner.
 */

import { describe, test, expect } from 'vitest';
import { loadScriptCJS } from '../helpers/load-script.js';

const { detectPlatformFromUrl } = loadScriptCJS('selectors.js');

describe('detectPlatformFromUrl', () => {
  test('WhatsApp Web — root path', () => {
    expect(detectPlatformFromUrl('https://web.whatsapp.com/')).toBe('whatsapp');
  });

  test('WhatsApp Web — chat path', () => {
    expect(detectPlatformFromUrl('https://web.whatsapp.com/?chat=123')).toBe('whatsapp');
  });

  test('LinkedIn Messaging', () => {
    expect(detectPlatformFromUrl('https://www.linkedin.com/messaging/'))
      .toBe('linkedin');
  });

  test('LinkedIn Messaging thread', () => {
    expect(detectPlatformFromUrl('https://www.linkedin.com/messaging/thread/2-abc/'))
      .toBe('linkedin');
  });

  test('Sales Navigator inbox is distinguished from regular LinkedIn', () => {
    expect(detectPlatformFromUrl('https://www.linkedin.com/sales/inbox/abc-123'))
      .toBe('sales_navigator');
  });

  test('LinkedIn home page is not "supported"', () => {
    expect(detectPlatformFromUrl('https://www.linkedin.com/feed/')).toBe(null);
  });

  test('LinkedIn user profile is not "supported"', () => {
    expect(detectPlatformFromUrl('https://www.linkedin.com/in/somebody/')).toBe(null);
  });

  test('LinkedIn post analytics page is not "supported" (would need separate platform)', () => {
    expect(detectPlatformFromUrl('https://www.linkedin.com/analytics/post/urn:li:activity:1234/'))
      .toBe(null);
  });

  test('Telegram Web', () => {
    expect(detectPlatformFromUrl('https://web.telegram.org/k/')).toBe('telegram');
  });

  test('Instagram DMs', () => {
    expect(detectPlatformFromUrl('https://www.instagram.com/direct/inbox/')).toBe('instagram');
  });

  test('Slack — not supported', () => {
    expect(detectPlatformFromUrl('https://app.slack.com/client/T1/D2')).toBe(null);
  });

  test('chrome:// internal pages', () => {
    expect(detectPlatformFromUrl('chrome://extensions/')).toBe(null);
  });

  test('garbage input does not throw', () => {
    expect(detectPlatformFromUrl('not a url')).toBe(null);
    expect(detectPlatformFromUrl('')).toBe(null);
    expect(detectPlatformFromUrl(null)).toBe(null);
    expect(detectPlatformFromUrl(undefined)).toBe(null);
  });
});
