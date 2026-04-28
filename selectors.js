/**
 * selectors.js — Centralized DOM selectors, organized by platform.
 *
 * MAINTENANCE: When a platform changes its UI, update selectors here.
 * Each selector set has a "primary" (semantic/aria) and "fallback" (structural).
 * The extraction code tries primary first, then fallback.
 *
 * To add a new platform:
 * 1. Add a new key to PLATFORM_SELECTORS
 * 2. Fill in selectors following the same shape
 * 3. Register the platform in PLATFORMS
 */

/* global globalThis */

const PLATFORMS = {
  sales_navigator: {
    id: 'sales_navigator',
    label: 'Sales Navigator',
    hostPatterns: ['*.linkedin.com'],
    messagingPath: '/sales/inbox/',
    csvPlatformName: 'Linkedin Sales Navigator',
  },
  linkedin: {
    id: 'linkedin',
    label: 'LinkedIn',
    hostPatterns: ['*.linkedin.com'],
    messagingPath: '/messaging/',
    csvPlatformName: 'Linkedin',
  },
  instagram: {
    id: 'instagram',
    label: 'Instagram',
    hostPatterns: ['*.instagram.com'],
    messagingPath: '/direct/',
    csvPlatformName: 'Instagram',
  },
  whatsapp: {
    id: 'whatsapp',
    label: 'WhatsApp',
    hostPatterns: ['web.whatsapp.com'],
    messagingPath: '/',
    csvPlatformName: 'Whatsapp',
  },
  telegram: {
    id: 'telegram',
    label: 'Telegram',
    hostPatterns: ['web.telegram.org'],
    messagingPath: '/',
    csvPlatformName: 'Telegram',
  },
};

const PLATFORM_SELECTORS = {
  // ── Sales Navigator ──
  // Selectors derived from live DOM inspection of linkedin.com/sales/inbox/.
  // The PR #2 attempt used [data-x--messaging-thread-list-item] which doesn't
  // exist in the actual Sales Navigator DOM — keeping the verified set here.
  sales_navigator: {
    conversationList: {
      primary: '[role="list"]',
      fallback: 'ul.list-style-none',
    },
    conversationItem: {
      primary: 'li.conversation-list-item',
      fallback: 'li[class*="conversation-list-item"]',
    },
    conversationItemName: {
      primary: '[data-anonymize="person-name"]',
      fallback: '.artdeco-entity-lockup__title .t-bold',
    },
    conversationItemPreview: {
      primary: '[data-anonymize="general-blurb"]',
      fallback: '.conversation-list-item__main-content .t-black--light',
    },
    conversationItemTime: {
      primary: 'time.conversation-list-item__timestamp',
      fallback: '.conversation-list-item__timestamp',
    },
    conversationItemLink: {
      primary: 'a.conversation-list-item__link',
      fallback: 'a[href*="/sales/inbox/"]',
    },
    // Message thread selectors (from live DOM inspection Feb 2026).
    // Each message is: <li> → <article> → <div data-x-message-content="message">
    // Sent msgs have no <address>; received msgs have <address> + <time datetime>.
    messageList: {
      primary: '[role="list"]:has([data-x-message-content])',
      fallback: 'ul:has(article)',
    },
    messageItem: {
      primary: 'li:has([data-x-message-content="message"])',
      fallback: 'article:has([data-x-message-content])',
    },
    messageSenderName: {
      primary: 'address.t-bold',
      fallback: 'address',
    },
    messageBody: {
      primary: 'div[data-x-message-content="message"]',
      fallback: 'p[data-anonymize="general-blurb"]',
    },
    messageTimestamp: {
      primary: 'time[datetime]',
      fallback: 'time.t-12',
    },
    messageGroup: {
      // Sales Navigator does NOT group messages — each is standalone.
      primary: '.sn-nonexistent-message-group',
      fallback: '.sn-nonexistent-message-group-2',
    },
    messageGroupMeta: {
      primary: '.sn-nonexistent-group-meta',
      fallback: '.sn-nonexistent-group-meta-2',
    },
    messageScrollContainer: {
      primary: '[role="list"]:has([data-x-message-content])',
      fallback: '[role="main"] [role="list"]',
    },
    conversationListScrollContainer: {
      primary: 'ul.list-style-none',
      fallback: '[role="list"]',
    },
  },

  // ── LinkedIn ──
  linkedin: {
    conversationList: {
      primary: '[role="list"]',
      fallback: '.msg-conversations-container__conversations-list',
    },
    conversationItem: {
      primary: 'li.msg-conversation-listitem',
      fallback: '.msg-conversation-listitem',
    },
    conversationItemName: {
      primary: '.msg-conversation-listitem__participant-names',
      fallback: '.msg-conversation-card__participant-names',
    },
    conversationItemPreview: {
      primary: '.msg-conversation-listitem__message-snippet',
      fallback: '.msg-conversation-card__message-snippet-body',
    },
    conversationItemTime: {
      primary: '.msg-conversation-listitem__time-stamp',
      fallback: '.msg-conversation-card__time-stamp',
    },
    conversationItemLink: {
      primary: 'a[href*="/messaging/thread/"]',
      fallback: '.msg-conversation-listitem__link',
    },
    messageList: {
      primary: '.msg-s-message-list-content',
      fallback: '[role="list"].msg-s-message-list-content',
    },
    messageItem: {
      primary: '.msg-s-event-listitem',
      fallback: '.msg-s-message-list__event',
    },
    messageSenderName: {
      primary: '.msg-s-message-group__name',
      fallback: '.msg-s-event-listitem__name',
    },
    messageBody: {
      primary: '.msg-s-event-listitem__body',
      fallback: '.msg-s-event__content',
    },
    messageTimestamp: {
      primary: '.msg-s-message-group__timestamp',
      fallback: 'time.msg-s-message-group__timestamp',
    },
    messageGroup: {
      primary: '.msg-s-message-group',
      fallback: '.msg-s-message-list__message-group',
    },
    messageGroupMeta: {
      primary: '.msg-s-message-group__meta',
      fallback: '.msg-s-message-group__profile-link',
    },
    messageScrollContainer: {
      primary: '.msg-s-message-list',
      fallback: '.msg-s-message-list-container',
    },
    conversationListScrollContainer: {
      primary: '.msg-conversations-container__conversations-list',
      fallback: '.msg-conversations-container',
    },
  },

  // ── Instagram (placeholder — fill when implementing) ──
  instagram: {
    conversationList: { primary: '[role="list"]', fallback: '._ab8s' },
    conversationItem: { primary: '[role="listitem"]', fallback: '._ab8s > div' },
    conversationItemName: { primary: 'span._ab8y', fallback: 'span' },
    conversationItemPreview: { primary: 'span._ab8w', fallback: 'span:last-child' },
    conversationItemTime: { primary: 'time', fallback: 'time' },
    conversationItemLink: { primary: 'a[href*="/direct/t/"]', fallback: 'a' },
    messageList: { primary: '[role="grid"]', fallback: '._aacp' },
    messageItem: { primary: '[role="row"]', fallback: '._aacl' },
    messageSenderName: { primary: 'span._aacl', fallback: 'span' },
    messageBody: { primary: 'div._aacl span', fallback: 'span' },
    messageTimestamp: { primary: 'time', fallback: 'time' },
    messageGroup: { primary: 'div', fallback: 'div' },
    messageGroupMeta: { primary: 'div', fallback: 'div' },
    messageScrollContainer: { primary: '[role="grid"]', fallback: '._aacp' },
  },

  // ── WhatsApp Web ──
  // Conversation-list selectors are scoped to #pane-side (the left rail) so they
  // do NOT pick up [role="listitem"] elements from the open chat or other
  // surfaces. WhatsApp dropped data-testid in 2024-2025; we use semantic roles
  // and structural fallbacks. Message-side selectors are best-effort and
  // intended to be revisited from a live DOM diagnose run.
  whatsapp: {
    // Selectors verified 2026-04-28 from a live diagnose run. WhatsApp Web
    // uses [role="row"] for chat-list items (not "listitem") and exposes
    // sender + timestamp inside `data-pre-plain-text` on each message.
    conversationList: { primary: '#pane-side div[role="grid"]', fallback: '#pane-side [aria-label]' },
    conversationItem: { primary: '#pane-side div[role="row"]', fallback: '#pane-side [role="listitem"]' },
    conversationItemName: { primary: 'span[title]', fallback: 'span[dir="auto"][title]' },
    conversationItemPreview: { primary: 'span[dir="ltr"]', fallback: 'span[dir="auto"]:nth-of-type(2)' },
    conversationItemTime: { primary: 'div._ak8i', fallback: 'span[aria-hidden="true"]' },
    conversationItemLink: { primary: 'div[role="row"]', fallback: 'div[role="listitem"]' },
    messageList: { primary: '#main .copyable-area', fallback: '#main' },
    messageItem: { primary: '#main div.message-in, #main div.message-out', fallback: '#main [role="row"]' },
    messageSenderName: { primary: 'span[aria-label]', fallback: 'span[dir="auto"]' },
    messageBody: { primary: 'span.copyable-text', fallback: 'div.copyable-text > span' },
    messageTimestamp: { primary: 'div[data-pre-plain-text]', fallback: 'span[aria-hidden="true"]' },
    messageGroup: { primary: '#main div.message-in, #main div.message-out', fallback: '#main [role="row"]' },
    messageGroupMeta: { primary: 'div[data-pre-plain-text]', fallback: 'span.copyable-text' },
    messageScrollContainer: { primary: '#main .copyable-area', fallback: '#main' },
  },

  // ── Telegram Web (placeholder — fill when implementing) ──
  telegram: {
    conversationList: { primary: '.chatlist', fallback: '#column-left .chatlist' },
    conversationItem: { primary: '.chatlist-chat', fallback: 'a.chatlist-chat' },
    conversationItemName: { primary: '.peer-title', fallback: '.row-title span' },
    conversationItemPreview: { primary: '.last-msg-text', fallback: '.subtitle span' },
    conversationItemTime: { primary: '.last-time', fallback: '.row-subtitle-wrapper time' },
    conversationItemLink: { primary: 'a.chatlist-chat', fallback: 'a' },
    messageList: { primary: '.bubbles-inner', fallback: '.messages-container' },
    messageItem: { primary: '.bubble', fallback: '.message' },
    messageSenderName: { primary: '.peer-title', fallback: '.name' },
    messageBody: { primary: '.message', fallback: '.text-content' },
    messageTimestamp: { primary: '.time', fallback: 'time' },
    messageGroup: { primary: '.bubbles-group', fallback: '.messages-group' },
    messageGroupMeta: { primary: '.bubble-name', fallback: '.name' },
    messageScrollContainer: { primary: '.bubbles', fallback: '.messages-container' },
  },
};

/**
 * Detect the current platform from the page URL.
 * Checks both hostname AND path to distinguish platforms sharing a host
 * (e.g. LinkedIn messaging vs Sales Navigator inbox).
 * @returns {string|null} Platform id or null
 */
function detectPlatform() {
  return detectPlatformFromUrl(location.href);
}

/**
 * Same as detectPlatform but takes a URL string — used by the service worker
 * (which doesn't have `location`) to identify what's loaded in the active tab.
 * @param {string} urlString
 * @returns {string|null}
 */
function detectPlatformFromUrl(urlString) {
  let host, path;
  try {
    const u = new URL(urlString);
    host = u.hostname;
    path = u.pathname;
  } catch {
    return null;
  }
  for (const [id, platform] of Object.entries(PLATFORMS)) {
    for (const pattern of platform.hostPatterns) {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      if (regex.test(host) && path.startsWith(platform.messagingPath)) return id;
    }
  }
  return null;
}

/**
 * Get selectors for a platform.
 * @param {string} platformId
 * @returns {object} Selector map
 */
function getSelectors(platformId) {
  return PLATFORM_SELECTORS[platformId] || {};
}

/**
 * Query using primary selector, fall back to fallback.
 * @param {Element} root
 * @param {object} selectorPair - { primary, fallback }
 * @returns {Element|null}
 */
function queryWithFallback(root, selectorPair) {
  if (!selectorPair) return null;
  let el = root.querySelector(selectorPair.primary);
  if (!el && selectorPair.fallback) {
    el = root.querySelector(selectorPair.fallback);
  }
  return el;
}

/**
 * QueryAll using primary selector, fall back to fallback.
 * @param {Element} root
 * @param {object} selectorPair - { primary, fallback }
 * @returns {Element[]}
 */
function queryAllWithFallback(root, selectorPair) {
  if (!selectorPair) return [];
  let els = root.querySelectorAll(selectorPair.primary);
  if (els.length === 0 && selectorPair.fallback) {
    els = root.querySelectorAll(selectorPair.fallback);
  }
  return Array.from(els);
}

// Make available globally
if (typeof globalThis !== 'undefined') {
  globalThis.PLATFORMS = PLATFORMS;
  globalThis.PLATFORM_SELECTORS = PLATFORM_SELECTORS;
  globalThis.detectPlatform = detectPlatform;
  globalThis.detectPlatformFromUrl = detectPlatformFromUrl;
  globalThis.getSelectors = getSelectors;
  globalThis.queryWithFallback = queryWithFallback;
  globalThis.queryAllWithFallback = queryAllWithFallback;
}
