/**
 * page-detect.test.js — detectPageInfo() taxonomy.
 *
 * Drives the smart banner: tells the user what page they're on and what
 * the plugin can do with it. If this drifts, the banner gives a wrong or
 * misleading recommendation.
 */

import { describe, test, expect } from 'vitest';
import { loadScriptCJS } from '../helpers/load-script.js';

const { detectPageInfo } = loadScriptCJS('selectors.js');

describe('detectPageInfo — happy paths (extraction works)', () => {
  test('Sales Navigator inbox is ready', () => {
    const r = detectPageInfo('https://www.linkedin.com/sales/inbox/abc-123');
    expect(r.platform).toBe('sales_navigator');
    expect(r.pageType).toBe('sales_inbox');
    expect(r.ready).toBe(true);
    expect(r.recommend).toMatch(/Scan/i);
  });

  test('WhatsApp Web is ready', () => {
    const r = detectPageInfo('https://web.whatsapp.com/');
    expect(r.platform).toBe('whatsapp');
    expect(r.ready).toBe(true);
  });
});

describe('detectPageInfo — known-but-blocked pages', () => {
  test('LinkedIn messaging is recognised but blocked (SDUI iframe)', () => {
    const r = detectPageInfo('https://www.linkedin.com/messaging/');
    expect(r.pageType).toBe('linkedin_messaging');
    expect(r.ready).toBe(false);
    expect(r.recommend).toMatch(/Sales Navigator/i);
  });

  test('LinkedIn messaging thread also recognised', () => {
    const r = detectPageInfo('https://www.linkedin.com/messaging/thread/2-abc/');
    expect(r.pageType).toBe('linkedin_messaging');
    expect(r.ready).toBe(false);
  });

  test('LinkedIn audience analytics — iframe blocker noted', () => {
    const r = detectPageInfo('https://www.linkedin.com/analytics/creator/audience/');
    expect(r.pageType).toBe('linkedin_audience_analytics');
    expect(r.ready).toBe(false);
    expect(r.recommend).toMatch(/iframe/i);
  });

  test('LinkedIn content analytics — iframe blocker noted', () => {
    const r = detectPageInfo('https://www.linkedin.com/analytics/creator/content/');
    expect(r.pageType).toBe('linkedin_content_analytics');
    expect(r.ready).toBe(false);
  });

  test('Per-post analytics URL', () => {
    const r = detectPageInfo('https://www.linkedin.com/analytics/post/urn:li:activity:1234/');
    expect(r.pageType).toBe('linkedin_post_analytics');
    expect(r.ready).toBe(false);
  });

  test('LinkedIn posts (recent-activity)', () => {
    const r = detectPageInfo('https://www.linkedin.com/in/kondratevakate/recent-activity/all/');
    expect(r.pageType).toBe('linkedin_posts');
    expect(r.ready).toBe(false);
  });

  test('Sales Navigator lead list detail', () => {
    const r = detectPageInfo('https://www.linkedin.com/sales/lists/people/7454891531720851456?sortCriteria=CREATED_TIME');
    expect(r.pageType).toBe('sales_lead_list_detail');
    expect(r.ready).toBe(false);
  });

  test('Sales Navigator home (alerts)', () => {
    const r = detectPageInfo('https://www.linkedin.com/sales/home');
    expect(r.pageType).toBe('sales_home');
    expect(r.ready).toBe(false);
  });

  test('LinkedIn profile (no activity path)', () => {
    const r = detectPageInfo('https://www.linkedin.com/in/somebody/');
    expect(r.pageType).toBe('linkedin_profile');
    expect(r.ready).toBe(false);
    // Recommend opening the activity tab
    expect(r.recommend).toMatch(/recent-activity/i);
  });

  test('LinkedIn feed', () => {
    const r = detectPageInfo('https://www.linkedin.com/feed/');
    expect(r.pageType).toBe('linkedin_feed');
    expect(r.ready).toBe(false);
  });
});

describe('detectPageInfo — unknown', () => {
  test('Slack is not supported', () => {
    const r = detectPageInfo('https://app.slack.com/client/T1/D2');
    expect(r.platform).toBe(null);
    expect(r.pageType).toBe('unknown');
    expect(r.ready).toBe(null);
  });

  test('garbage input never throws', () => {
    expect(detectPageInfo('not a url').pageType).toBe('unknown');
    expect(detectPageInfo('').pageType).toBe('unknown');
    expect(detectPageInfo(null).pageType).toBe('unknown');
  });

  test('chrome:// internal page', () => {
    const r = detectPageInfo('chrome://extensions/');
    expect(r.pageType).toBe('unknown');
  });
});
