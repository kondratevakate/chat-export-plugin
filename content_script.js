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

  async function extractChat(chatKey, settings) {
    const n = settings?.messagesPerChat || 8;
    const senderName = settings?.senderName || 'Kate Kondrateva';
    let state = State.OPEN_CHAT;
    const startTime = Date.now();

    try {
      // ── OPEN_CHAT ──
      if (state === State.OPEN_CHAT) {
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
          return { error: 'Messages did not render in time', chatKey };
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

        // Filter to first N messages authored by the user
        const myMessages = allMessages.filter(m => m.sender === senderName);
        const firstN = myMessages.slice(0, n);

        // If rowMode includes all messages (both sides), return all but capped
        // For "one row per message" with only sender's messages:
        return {
          messages: firstN,
          allMessages: allMessages.slice(0, n * 3), // Keep context for conversation mode
          chatKey,
          total: allMessages.length,
          collected: firstN.length,
          partial: firstN.length < n,
        };
      }
    } catch (err) {
      return { error: err.message, chatKey };
    }

    return { error: 'Unexpected state', chatKey };
  }

  // ── State Machine Helpers ──

  async function openChat(chatKey) {
    // Find the conversation item and click it
    const items = queryAllWithFallback(document, SEL.conversationItem);

    for (const item of items) {
      const link = queryWithFallback(item, SEL.conversationItemLink);
      if (link?.href?.includes(chatKey)) {
        link.click();
        await sleep(800);
        return true;
      }

      // Fallback: match by name
      const nameEl = queryWithFallback(item, SEL.conversationItemName);
      const name = cleanText(nameEl?.textContent);
      const expectedName = chatKeyToName(chatKey);
      if (name && expectedName && name.toLowerCase() === expectedName.toLowerCase()) {
        const clickTarget = link || item;
        clickTarget.click();
        await sleep(800);
        return true;
      }
    }

    // Last resort: try navigating directly
    if (chatKey && !chatKey.startsWith('chat_')) {
      const currentUrl = location.href;
      // Use the correct URL pattern for the current platform
      const basePath = platformId === 'sales_navigator'
        ? '/sales/inbox/' + chatKey + '/'
        : '/messaging/thread/' + chatKey + '/';
      const base = location.origin + basePath;
      if (!currentUrl.includes(chatKey)) {
        location.href = base;
        await sleep(2000);
        return true;
      }
    }

    return false;
  }

  async function waitForMessages() {
    const deadline = Date.now() + LIMITS.renderTimeout;
    while (Date.now() < deadline) {
      const messageList = queryWithFallback(document, SEL.messageList);
      if (messageList) {
        const items = queryAllWithFallback(messageList, SEL.messageItem);
        if (items.length > 0) return true;
      }
      // Also try message groups
      const groups = queryAllWithFallback(document, SEL.messageGroup);
      if (groups.length > 0) return true;

      // Sales Navigator: messages use data-x-message-content, check globally
      const snMessages = document.querySelectorAll('[data-x-message-content="message"]');
      if (snMessages.length > 0) return true;

      await sleep(300);
    }
    return false;
  }

  async function scrollToLoadMore(startTime) {
    const scrollContainer = queryWithFallback(document, SEL.messageScrollContainer);
    if (!scrollContainer) return;

    let attempts = 0;
    let lastHeight = scrollContainer.scrollHeight;

    while (attempts < LIMITS.maxScrollAttempts) {
      if (Date.now() - startTime > LIMITS.maxTimePerChat) break;

      scrollContainer.scrollTop = 0; // Scroll to top
      await sleep(LIMITS.scrollPause);

      const newHeight = scrollContainer.scrollHeight;
      if (newHeight === lastHeight) {
        // No new content loaded — we've likely reached the top
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

    // Strategy 1: Collect from message groups (LinkedIn groups sequential messages)
    const groups = queryAllWithFallback(document, SEL.messageGroup);
    console.log(`[ChatExport] Strategy 1 — message groups: ${groups.length} (selector: ${SEL.messageGroup.primary})`);

    if (groups.length > 0) {
      for (const group of groups) {
        const nameEl = queryWithFallback(group, SEL.messageSenderName);
        const timeEl = queryWithFallback(group, SEL.messageTimestamp);
        const sender = cleanText(nameEl?.textContent) || '';
        const timestamp = timeEl?.getAttribute('datetime') || cleanText(timeEl?.textContent) || '';

        // Each group may contain multiple message bubbles
        const bodies = queryAllWithFallback(group, SEL.messageBody);
        for (const body of bodies) {
          const text = cleanText(body?.textContent);
          if (!text) continue;

          // Determine if this is the user's message or the contact's
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

    // Strategy 2: Flat message items (fallback, and primary for Sales Navigator)
    if (messages.length === 0) {
      const items = queryAllWithFallback(document, SEL.messageItem);
      console.log(`[ChatExport] Strategy 2 — flat items: ${items.length} (selector: ${SEL.messageItem.primary})`);

      // Debug: check raw existence of key elements
      const rawDataX = document.querySelectorAll('[data-x-message-content]');
      const rawDataXMsg = document.querySelectorAll('[data-x-message-content="message"]');
      console.log(`[ChatExport] Raw [data-x-message-content]: ${rawDataX.length}, [data-x-message-content="message"]: ${rawDataXMsg.length}`);
      if (rawDataX.length > 0 && rawDataXMsg.length === 0) {
        // The attribute value changed — log what we see
        const sampleValues = [...rawDataX].slice(0, 5).map(el => el.getAttribute('data-x-message-content'));
        console.log(`[ChatExport] data-x-message-content values:`, sampleValues);
      }

      for (const item of items) {
        const nameEl = queryWithFallback(item, SEL.messageSenderName);
        const bodyEl = queryWithFallback(item, SEL.messageBody);
        const timeEl = queryWithFallback(item, SEL.messageTimestamp);

        const sender = cleanText(nameEl?.textContent) || '';
        const text = cleanText(bodyEl?.textContent);
        // Prefer ISO datetime attribute (Sales Navigator uses time[datetime])
        const timestamp = timeEl?.getAttribute('datetime') || cleanText(timeEl?.textContent) || '';

        if (!text) continue;

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

      // Strategy 3: Direct fallback using [data-x-message-content] if selectors missed
      if (messages.length === 0 && rawDataX.length > 0) {
        console.log(`[ChatExport] Strategy 3 — direct data-x-message-content fallback`);
        for (const el of rawDataX) {
          const text = cleanText(el.textContent);
          if (!text) continue;

          // Walk up to find the containing list item
          const li = el.closest('li') || el.closest('article') || el.parentElement;
          const nameEl = li?.querySelector('address') || li?.querySelector('[data-anonymize="person-name"]');
          const timeEl = li?.querySelector('time[datetime]') || li?.querySelector('time');
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
        console.log(`[ChatExport] Strategy 3 found: ${messages.length} messages`);
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
