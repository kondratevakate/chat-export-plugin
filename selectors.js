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

  // ── WhatsApp Web (placeholder — fill when implementing) ──
  whatsapp: {
    conversationList: { primary: '[role="listitem"]', fallback: '#pane-side [role="grid"]' },
    conversationItem: { primary: '[role="listitem"]', fallback: '[data-testid="cell-frame-container"]' },
    conversationItemName: { primary: '[data-testid="cell-frame-title"] span', fallback: 'span[dir="auto"]' },
    conversationItemPreview: { primary: '[data-testid="last-msg-status"] span', fallback: 'span[dir="ltr"]' },
    conversationItemTime: { primary: '[data-testid="cell-frame-primary-detail"]', fallback: 'div._ak8i' },
    conversationItemLink: { primary: '[role="listitem"]', fallback: '[data-testid="cell-frame-container"]' },
    messageList: { primary: '[role="application"]', fallback: '#main [data-testid="conversation-panel-messages"]' },
    messageItem: { primary: '[data-testid="msg-container"]', fallback: '.message-in, .message-out' },
    messageSenderName: { primary: '[data-testid="msg-meta"] span', fallback: 'span[dir="auto"]' },
    messageBody: { primary: '[data-testid="msg-container"] span.selectable-text', fallback: 'span.selectable-text' },
    messageTimestamp: { primary: '[data-testid="msg-meta"]', fallback: 'span[dir="auto"]' },
    messageGroup: { primary: 'div', fallback: 'div' },
    messageGroupMeta: { primary: 'div', fallback: 'div' },
    messageScrollContainer: { primary: '[data-testid="conversation-panel-body"]', fallback: '#main .copyable-area' },
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
 * @returns {string|null} Platform id or null
 */
function detectPlatform() {
  const host = location.hostname;
  for (const [id, platform] of Object.entries(PLATFORMS)) {
    for (const pattern of platform.hostPatterns) {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      if (regex.test(host)) return id;
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
  globalThis.getSelectors = getSelectors;
  globalThis.queryWithFallback = queryWithFallback;
  globalThis.queryAllWithFallback = queryAllWithFallback;
}
