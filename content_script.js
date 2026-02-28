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
  if (!platformId) return; // Not on a supported platform

  const platform = PLATFORMS[platformId];
  const SEL = getSelectors(platformId);

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
    handleMessage(message).then(sendResponse).catch(err => {
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
      default:
        return { error: `Unknown action: ${action}` };
    }
  }

  // ── Scan Inbox ──
  // Scrolls through the conversation list to load all conversations, then extracts them

  async function scanInbox() {
    const listContainer = queryWithFallback(document, SEL.conversationList);
    if (!listContainer) {
      return { error: 'Cannot find conversation list. Make sure you are on the messaging page.' };
    }

    // Auto-scroll the conversation list to load all conversations
    await autoScrollConversationList(listContainer);

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

  async function autoScrollConversationList(listContainer) {
    // Find the scrollable container (the list itself or its parent)
    const scrollContainer = queryWithFallback(document, SEL.conversationListScrollContainer)
      || listContainer.closest('.msg-conversations-container')
      || listContainer.parentElement;
    if (!scrollContainer) return;

    const maxAttempts = 50;
    const scrollPause = 500;
    let attempts = 0;
    let lastItemCount = 0;
    let stableRounds = 0;

    while (attempts < maxAttempts) {
      const currentItems = queryAllWithFallback(listContainer, SEL.conversationItem);
      const currentCount = currentItems.length;

      if (currentCount === lastItemCount) {
        stableRounds++;
        // If count hasn't changed for 3 consecutive scrolls, we've loaded everything
        if (stableRounds >= 3) break;
      } else {
        stableRounds = 0;
      }

      lastItemCount = currentCount;

      // Scroll to the bottom of the conversation list
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      await sleep(scrollPause);
      attempts++;
    }
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
        const match = linkEl.href.match(/thread\/([^/?\s]+)/);
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

    // Last resort: try navigating directly (LinkedIn supports direct thread URLs)
    if (chatKey && !chatKey.startsWith('chat_')) {
      const currentUrl = location.href;
      const base = location.origin + '/messaging/thread/' + chatKey + '/';
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

    if (groups.length > 0) {
      for (const group of groups) {
        const nameEl = queryWithFallback(group, SEL.messageSenderName);
        const timeEl = queryWithFallback(group, SEL.messageTimestamp);
        const sender = cleanText(nameEl?.textContent) || '';
        const timestamp = cleanText(timeEl?.textContent) || '';

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

    // Strategy 2: Flat message items (fallback)
    if (messages.length === 0) {
      const items = queryAllWithFallback(document, SEL.messageItem);
      for (const item of items) {
        const nameEl = queryWithFallback(item, SEL.messageSenderName);
        const bodyEl = queryWithFallback(item, SEL.messageBody);
        const timeEl = queryWithFallback(item, SEL.messageTimestamp);

        const sender = cleanText(nameEl?.textContent) || '';
        const text = cleanText(bodyEl?.textContent);
        const timestamp = cleanText(timeEl?.textContent) || '';

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

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

})();
