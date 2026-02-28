/**
 * content_script.js — DOM extraction for messaging platforms.
 *
 * Runs on messaging pages. Communicates with service worker via chrome.runtime.
 * Implements a state-machine for reliable extraction.
 *
 * Platform-agnostic: uses selectors.js to adapt to LinkedIn, Instagram, etc.
 */

/* global PLATFORMS, detectPlatform, getSelectors, queryWithFallback, queryAllWithFallback */

(() => {
  'use strict';

  // ── Platform Detection ──
  const platformId = detectPlatform();
  console.log('[ChatExport] Platform detected:', platformId, '| URL:', location.href);
  if (!platformId) return; // Not on a supported platform

  const platform = PLATFORMS[platformId];
  const SEL = getSelectors(platformId);
  console.log('[ChatExport] Content script loaded for', platform.label);

  // ── Extraction States ──
  const State = {
    IDLE: 'IDLE',
    OPEN_CHAT: 'OPEN_CHAT',
    WAIT_RENDER: 'WAIT_RENDER',
    SCROLL_TOP: 'SCROLL_TOP',
    COLLECT: 'COLLECT',
    DONE: 'DONE',
    FAILED: 'FAILED',
  };

  // ── Limits ──
  const LIMITS = {
    maxScrollAttempts: 25,
    maxTimePerChat: 20000,   // 20 seconds
    scrollPause: 400,        // ms between scroll attempts
    renderTimeout: 5000,     // wait for messages to appear
    openTimeout: 3000,       // wait for chat to open
  };

  // ── Message Listener ──
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('[ChatExport] Received message:', message.action);
    handleMessage(message).then(result => {
      console.log('[ChatExport] Response for', message.action, ':', result.error || `OK (${result.chats?.length || result.messages?.length || 0} items)`);
      sendResponse(result);
    }).catch(err => {
      console.error('[ChatExport] Error in', message.action, ':', err);
      sendResponse({ error: err.message });
    });
    return true;
  });

  async function handleMessage(message) {
    const { action, payload } = message;

    switch (action) {
      case 'scanInbox':
        return scanInbox();
      case 'extractChat':
        return extractChat(payload.chatKey, payload.settings);
      case 'diagnose':
        return runDiagnostics();
      default:
        return { error: `Unknown action: ${action}` };
    }
  }

  // ── Scan Inbox ──
  // Reads the visible conversation list from the sidebar

  async function scanInbox() {
    const listContainer = queryWithFallback(document, SEL.conversationList);
    if (!listContainer) {
      return { error: 'Cannot find conversation list. Make sure you are on the messaging page.' };
    }

    // Auto-scroll the conversation list to load more chats (LinkedIn lazy-loads ~20 at a time)
    const scrollTarget = listContainer.closest('[style*="overflow"]')
      || listContainer.parentElement
      || listContainer;

    let prevCount = 0;
    let stableRounds = 0;
    const maxScrollAttempts = 30;

    for (let i = 0; i < maxScrollAttempts; i++) {
      const currentItems = queryAllWithFallback(listContainer, SEL.conversationItem);
      const currentCount = currentItems.length;
      console.log(`[ChatExport] Scan scroll #${i}: ${currentCount} conversations loaded`);

      if (currentCount === prevCount) {
        stableRounds++;
        if (stableRounds >= 3) break; // No new items after 3 scroll attempts
      } else {
        stableRounds = 0;
      }
      prevCount = currentCount;

      // Scroll the conversation list down
      scrollTarget.scrollTop = scrollTarget.scrollHeight;
      // Also try scrolling the last item into view
      if (currentItems.length > 0) {
        currentItems[currentItems.length - 1].scrollIntoView({ block: 'end' });
      }
      await sleep(800);
    }

    const items = queryAllWithFallback(listContainer, SEL.conversationItem);
    if (items.length === 0) {
      // Try broader search on entire document
      const broadItems = queryAllWithFallback(document, SEL.conversationItem);
      if (broadItems.length === 0) {
        return { error: 'No conversations found in the list. Scroll to load some conversations first.' };
      }
      return { chats: broadItems.map(parseChatItem).filter(Boolean), platform: platformId };
    }

    const chats = items.map(parseChatItem).filter(Boolean);
    console.log(`[ChatExport] Scan complete: ${chats.length} chats found`);
    return { chats, platform: platformId };
  }

  function parseChatItem(itemEl) {
    try {
      const nameEl = queryWithFallback(itemEl, SEL.conversationItemName);
      const previewEl = queryWithFallback(itemEl, SEL.conversationItemPreview);
      const timeEl = queryWithFallback(itemEl, SEL.conversationItemTime);
      const linkEl = queryWithFallback(itemEl, SEL.conversationItemLink);

      const displayName = cleanText(nameEl?.textContent);
      if (!displayName) return null;

      // Derive a stable chatKey from the link href or name
      let chatKey = '';
      if (linkEl?.href) {
        // Support both LinkedIn /messaging/thread/{id} and Sales Navigator /sales/inbox/{id}
        const match = linkEl.href.match(/(?:thread|inbox)\/([^/?\s]+)/);
        chatKey = match ? match[1] : linkEl.href;
      }
      if (!chatKey) {
        chatKey = 'chat_' + displayName.replace(/\s+/g, '_').toLowerCase();
      }

      return {
        chatKey,
        displayName,
        lastPreview: cleanText(previewEl?.textContent) || '',
        lastActivityHint: cleanText(timeEl?.textContent) || '',
        profileUrl: linkEl?.href || '',
      };
    } catch {
      return null;
    }
  }

  // ── Extract Chat Messages ──
  // State machine: OPEN_CHAT -> WAIT_RENDER -> SCROLL_TOP -> COLLECT -> DONE

  // Track previous chat's message fingerprint to detect DOM changes
  let _prevMessageFingerprint = '';

  function getMessageFingerprint() {
    const els = document.querySelectorAll('[data-x-message-content]');
    if (els.length === 0) return '';
    // Use first message's text as fingerprint
    return els[0].textContent.slice(0, 80);
  }

  async function extractChat(chatKey, settings) {
    const n = settings?.messagesPerChat || 8;
    const senderName = settings?.senderName || 'Kate Kondrateva';
    let state = State.OPEN_CHAT;
    const startTime = Date.now();
    const debug = [];

    try {
      // ── OPEN_CHAT ──
      if (state === State.OPEN_CHAT) {
        // Record current message fingerprint BEFORE clicking new chat
        _prevMessageFingerprint = getMessageFingerprint();
        const opened = await openChat(chatKey);
        if (!opened) {
          return { error: 'Could not open chat', chatKey };
        }
        state = State.WAIT_RENDER;
      }

      // ── WAIT_RENDER ──
      if (state === State.WAIT_RENDER) {
        const rendered = await waitForMessages();
        if (!rendered) {
          debug.push('waitForMessages timed out');
          return { error: 'Messages did not render in time', chatKey, debug };
        }
        state = State.SCROLL_TOP;
      }

      // ── SCROLL_TOP (optional — try to load older messages) ──
      if (state === State.SCROLL_TOP) {
        await scrollToLoadMore(startTime);
        state = State.COLLECT;
      }

      // ── COLLECT ──
      if (state === State.COLLECT) {
        const contactName = getContactNameFromHeader() || chatKeyToName(chatKey);
        const allMessages = collectMessages(senderName, contactName, chatKey);
        debug.push(`all=${allMessages.length}`);

        // Filter to first N messages authored by the user
        const myMessages = allMessages.filter(m => m.sender === senderName);
        debug.push(`mine=${myMessages.length}`);
        const firstN = myMessages.slice(0, n);

        return {
          messages: firstN,
          allMessages: allMessages.slice(0, n * 3),
          chatKey,
          total: allMessages.length,
          collected: firstN.length,
          partial: firstN.length < n,
          debug,
        };
      }
    } catch (err) {
      return { error: err.message, chatKey, debug };
    }

    return { error: 'Unexpected state', chatKey, debug };
  }

  // ── State Machine Helpers ──

  async function openChat(chatKey) {
    // Find the conversation item and click it
    const items = queryAllWithFallback(document, SEL.conversationItem);

    for (const item of items) {
      const link = queryWithFallback(item, SEL.conversationItemLink);
      if (link?.href?.includes(chatKey)) {
        link.click();
        await sleep(1500);
        return true;
      }

      // Fallback: match by name
      const nameEl = queryWithFallback(item, SEL.conversationItemName);
      const name = cleanText(nameEl?.textContent);
      const expectedName = chatKeyToName(chatKey);
      if (name && expectedName && name.toLowerCase() === expectedName.toLowerCase()) {
        const clickTarget = link || item;
        clickTarget.click();
        await sleep(1500);
        return true;
      }
    }

    // Do NOT use location.href navigation — it destroys the content script
    // and breaks all subsequent chat processing. Just skip this chat.
    console.warn(`[ChatExport] Could not find chat ${chatKey} in conversation list. Skipping.`);
    return false;
  }

  async function waitForMessages() {
    const deadline = Date.now() + LIMITS.renderTimeout;

    // For Sales Navigator: wait for the message content to CHANGE from
    // the previous chat (prevents reading stale DOM from the prior chat)
    if (platformId === 'sales_navigator') {
      while (Date.now() < deadline) {
        const currentFp = getMessageFingerprint();
        const dataXEls = document.querySelectorAll('[data-x-message-content]');

        // Messages present AND different from previous chat
        if (dataXEls.length > 0 && currentFp !== _prevMessageFingerprint) {
          return true;
        }
        // If no previous fingerprint (first chat), just check presence
        if (!_prevMessageFingerprint && dataXEls.length > 0) {
          return true;
        }

        await sleep(300);
      }
      // Last resort: accept whatever is there (might be same chat reopened)
      const dataXEls = document.querySelectorAll('[data-x-message-content]');
      if (dataXEls.length > 0) return true;
      return false;
    }

    // Standard LinkedIn / other platforms
    while (Date.now() < deadline) {
      const messageList = queryWithFallback(document, SEL.messageList);
      if (messageList) {
        const items = queryAllWithFallback(messageList, SEL.messageItem);
        if (items.length > 0) return true;
      }
      const groups = queryAllWithFallback(document, SEL.messageGroup);
      if (groups.length > 0) return true;

      const snMessages = document.querySelectorAll('[data-x-message-content="message"]');
      if (snMessages.length > 0) return true;

      await sleep(300);
    }
    return false;
  }

  async function scrollToLoadMore(startTime) {
    // Try the configured selector first
    let scrollContainer = queryWithFallback(document, SEL.messageScrollContainer);

    // Sales Navigator: find scroll container dynamically
    if (!scrollContainer && platformId === 'sales_navigator') {
      // Find the message list (ul containing articles) and walk up to the scrollable parent
      const messageUl = document.querySelector('ul:has(article [data-x-message-content])');
      if (messageUl) {
        // Walk up to find the first scrollable ancestor
        let el = messageUl;
        while (el && el !== document.body) {
          const style = getComputedStyle(el);
          const overflowY = style.overflowY;
          if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight) {
            scrollContainer = el;
            break;
          }
          el = el.parentElement;
        }
        // If no scrollable parent found, try the ul itself
        if (!scrollContainer && messageUl.scrollHeight > messageUl.clientHeight) {
          scrollContainer = messageUl;
        }
      }
    }

    if (!scrollContainer) {
      console.log('[ChatExport] No scroll container found for messages');
      return;
    }

    console.log(`[ChatExport] Scrolling message container (tag: ${scrollContainer.tagName}, height: ${scrollContainer.scrollHeight})`);
    let attempts = 0;
    let lastHeight = scrollContainer.scrollHeight;

    while (attempts < LIMITS.maxScrollAttempts) {
      if (Date.now() - startTime > LIMITS.maxTimePerChat) break;

      scrollContainer.scrollTop = 0; // Scroll to top
      await sleep(LIMITS.scrollPause);

      const newHeight = scrollContainer.scrollHeight;
      if (newHeight === lastHeight) {
        break;
      }
      lastHeight = newHeight;
      attempts++;
    }
  }

  function getContactNameFromHeader() {
    // Try to get the contact name from the currently open chat header
    // Sales Navigator: the active conversation item has class "active"
    if (platformId === 'sales_navigator') {
      const activeItem = document.querySelector('a.conversation-list-item__link.active [data-anonymize="person-name"]');
      if (activeItem) return cleanText(activeItem.textContent);
      // Fallback: any person-name in the lockup title area
      const lockupName = document.querySelector('.artdeco-entity-lockup__title [data-anonymize="person-name"]');
      if (lockupName) return cleanText(lockupName.textContent);
    }
    // LinkedIn messaging selectors
    const headerName = document.querySelector(
      '.msg-overlay-bubble-header__title, ' +
      '.msg-thread__link-to-profile, ' +
      '.msg-entity-lockup__entity-title, ' +
      'h2.msg-overlay-bubble-header__title'
    );
    return cleanText(headerName?.textContent);
  }

  function collectMessages(senderName, contactName, chatKey) {
    const messages = [];

    // ── Sales Navigator: Direct extraction using [data-x-message-content] ──
    // This is the most reliable approach — find message content divs directly
    // and walk up the DOM tree for metadata.
    if (platformId === 'sales_navigator') {
      const rawDataX = document.querySelectorAll('[data-x-message-content]');
      console.log(`[ChatExport] SN direct extraction: ${rawDataX.length} [data-x-message-content] elements`);

      for (const el of rawDataX) {
        const text = cleanText(el.textContent);
        if (!text) continue;

        // Walk up to find the containing list item or article
        const container = el.closest('li') || el.closest('article') || el.parentElement;
        const nameEl = container?.querySelector('address') || container?.querySelector('[data-anonymize="person-name"]');
        const timeEl = container?.querySelector('time[datetime]') || container?.querySelector('time');
        const sender = cleanText(nameEl?.textContent) || '';
        const timestamp = timeEl?.getAttribute('datetime') || cleanText(timeEl?.textContent) || '';

        // Sales Navigator: sent messages have no <address> element,
        // so empty sender means it's the current user's message
        const isMine = !sender || isSenderMatch(sender, senderName);
        messages.push({
          platform: platform.csvPlatformName,
          messageDateRaw: timestamp,
          sender: isMine ? senderName : sender || contactName,
          receiver: isMine ? contactName : senderName,
          text,
          chatKey,
        });
      }

      // If direct extraction found nothing, also try the messageItem selectors
      if (messages.length === 0) {
        const items = queryAllWithFallback(document, SEL.messageItem);
        console.log(`[ChatExport] SN fallback — messageItem: ${items.length}`);
        for (const item of items) {
          const bodyEl = queryWithFallback(item, SEL.messageBody);
          const text = cleanText(bodyEl?.textContent);
          if (!text) continue;
          const nameEl = queryWithFallback(item, SEL.messageSenderName);
          const timeEl = queryWithFallback(item, SEL.messageTimestamp);
          const sender = cleanText(nameEl?.textContent) || '';
          const timestamp = timeEl?.getAttribute('datetime') || cleanText(timeEl?.textContent) || '';
          const isMine = !sender || isSenderMatch(sender, senderName);
          messages.push({
            platform: platform.csvPlatformName,
            messageDateRaw: timestamp,
            sender: isMine ? senderName : sender || contactName,
            receiver: isMine ? contactName : senderName,
            text,
            chatKey,
          });
        }
      }

      console.log(`[ChatExport] SN collectMessages total: ${messages.length} (sender: "${senderName}", contact: "${contactName}")`);
      return messages;
    }

    // ── Standard LinkedIn / other platforms ──

    // Strategy 1: Collect from message groups (LinkedIn groups sequential messages)
    const groups = queryAllWithFallback(document, SEL.messageGroup);
    console.log(`[ChatExport] Strategy 1 — message groups: ${groups.length} (selector: ${SEL.messageGroup.primary})`);

    if (groups.length > 0) {
      for (const group of groups) {
        const nameEl = queryWithFallback(group, SEL.messageSenderName);
        const timeEl = queryWithFallback(group, SEL.messageTimestamp);
        const sender = cleanText(nameEl?.textContent) || '';
        const timestamp = timeEl?.getAttribute('datetime') || cleanText(timeEl?.textContent) || '';

        const bodies = queryAllWithFallback(group, SEL.messageBody);
        for (const body of bodies) {
          const text = cleanText(body?.textContent);
          if (!text) continue;

          const isMine = isSenderMatch(sender, senderName);
          messages.push({
            platform: platform.csvPlatformName,
            messageDateRaw: timestamp,
            sender: isMine ? senderName : sender || contactName,
            receiver: isMine ? contactName : senderName,
            text,
            chatKey,
          });
        }
      }
    }

    // Strategy 2: Flat message items
    if (messages.length === 0) {
      const items = queryAllWithFallback(document, SEL.messageItem);
      console.log(`[ChatExport] Strategy 2 — flat items: ${items.length} (selector: ${SEL.messageItem.primary})`);

      for (const item of items) {
        const nameEl = queryWithFallback(item, SEL.messageSenderName);
        const bodyEl = queryWithFallback(item, SEL.messageBody);
        const timeEl = queryWithFallback(item, SEL.messageTimestamp);

        const sender = cleanText(nameEl?.textContent) || '';
        const text = cleanText(bodyEl?.textContent);
        const timestamp = timeEl?.getAttribute('datetime') || cleanText(timeEl?.textContent) || '';

        if (!text) continue;

        const isMine = !sender || isSenderMatch(sender, senderName);
        messages.push({
          platform: platform.csvPlatformName,
          messageDateRaw: timestamp,
          sender: isMine ? senderName : sender || contactName,
          receiver: isMine ? contactName : senderName,
          text,
          chatKey,
        });
      }
    }

    console.log(`[ChatExport] collectMessages total: ${messages.length} (sender: "${senderName}", contact: "${contactName}")`);
    return messages;
  }

  // ── Utilities ──

  function isSenderMatch(extracted, senderName) {
    if (!extracted || !senderName) return false;
    const a = extracted.toLowerCase().trim();
    const b = senderName.toLowerCase().trim();
    // Match full name, or first name, or partial
    return a === b || a.startsWith(b.split(' ')[0].toLowerCase()) || b.includes(a);
  }

  function chatKeyToName(chatKey) {
    if (chatKey.startsWith('chat_')) {
      return chatKey.replace('chat_', '').replace(/_/g, ' ');
    }
    return chatKey;
  }

  function cleanText(str) {
    if (!str) return '';
    return str.replace(/\s+/g, ' ').trim();
  }

  // ── Diagnostics ──
  // Returns info about what the content script can see in the DOM

  function runDiagnostics() {
    const results = {
      platform: platformId,
      url: location.href,
      selectors: {},
      sampleHTML: '',
    };

    // Check every selector in SEL and report how many elements match
    for (const [key, pair] of Object.entries(SEL)) {
      const primaryCount = document.querySelectorAll(pair.primary).length;
      const fallbackCount = pair.fallback ? document.querySelectorAll(pair.fallback).length : 0;
      results.selectors[key] = {
        primary: `${pair.primary} → ${primaryCount}`,
        fallback: `${pair.fallback || '(none)'} → ${fallbackCount}`,
      };
    }

    // Find all CSS classes containing "msg" or "message" in the main content area
    const mainArea = document.querySelector('[role="main"]') || document.body;
    const allElements = mainArea.querySelectorAll('*');
    const msgClasses = new Set();
    const messageClasses = new Set();
    for (const el of allElements) {
      if (!el.className || typeof el.className !== 'string') continue;
      for (const cls of el.className.split(/\s+/)) {
        if (cls.includes('msg-') || cls.includes('msg_')) msgClasses.add(cls);
        if (cls.includes('message')) messageClasses.add(cls);
      }
    }
    results.msgClasses = [...msgClasses].sort().slice(0, 50);
    results.messageClasses = [...messageClasses].sort().slice(0, 50);

    // Sample HTML: the first message-like container we can find
    const sampleSources = [
      '.msg-s-message-list-content',
      '.msg-s-message-group',
      '.msg-s-event-listitem',
      '[data-x-message-content]',
      '[role="main"] [role="list"]',
      '[role="main"] ul',
    ];
    for (const sel of sampleSources) {
      const el = document.querySelector(sel);
      if (el) {
        // Get first child or self, trimmed
        const sample = el.outerHTML.slice(0, 1500);
        results.sampleHTML = `Matched: ${sel}\n` + sample;
        break;
      }
    }

    // If nothing found, grab some structure from [role="main"]
    if (!results.sampleHTML) {
      const main = document.querySelector('[role="main"]');
      if (main) {
        // Show tag structure of first 3 levels
        const structure = describeElement(main, 3);
        results.sampleHTML = 'No message selectors matched. [role="main"] structure:\n' + structure;
      } else {
        results.sampleHTML = 'No [role="main"] element found on page.';
      }
    }

    return results;
  }

  function describeElement(el, depth, indent = '') {
    if (depth <= 0 || !el) return '';
    const tag = el.tagName?.toLowerCase() || '?';
    const cls = el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : '';
    const role = el.getAttribute?.('role') ? `[role="${el.getAttribute('role')}"]` : '';
    const id = el.id ? `#${el.id}` : '';
    let line = `${indent}<${tag}${id}${cls}${role}> (${el.children?.length || 0} children)\n`;
    if (el.children) {
      for (let i = 0; i < Math.min(el.children.length, 8); i++) {
        line += describeElement(el.children[i], depth - 1, indent + '  ');
      }
      if (el.children.length > 8) {
        line += `${indent}  ... and ${el.children.length - 8} more\n`;
      }
    }
    return line;
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

})();
