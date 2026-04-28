/**
 * content_script.js — DOM extraction for messaging platforms.
 *
 * Runs on messaging pages. Communicates with service worker via chrome.runtime.
 * Implements a state-machine for reliable extraction.
 *
 * Platform-agnostic: uses selectors.js to adapt to LinkedIn, Instagram, etc.
 */

/* global PLATFORMS, detectPlatform, getSelectors, queryWithFallback, queryAllWithFallback, Logger, Extractor */

(() => {
  'use strict';

  // ── Platform Detection ──
  const platformId = detectPlatform();
  const log = (typeof Logger !== 'undefined' ? Logger.logFor('cs') : { info: console.log, warn: console.warn, error: console.error });
  log.info('platform.detect', { platform: platformId, url: location.href });
  if (!platformId) return; // Not on a supported platform

  const platform = PLATFORMS[platformId];
  const SEL = getSelectors(platformId);
  log.info('content.loaded', { platform: platform.label });

  // ── Abort flag (set by service worker on cancel) ──
  // Checked inside long-running scroll/wait loops so Cancel returns control
  // within ~one scroll-pause instead of up to maxTimePerChat (20 s).
  let abortFlag = false;

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
  // Test mode (cold/dry run) uses tight timeouts so the user can answer
  // "does this work at all?" in seconds. Full mode keeps the longer budgets
  // since we actually want to scroll-load older history.
  const LIMITS = {
    maxScrollAttempts: 25,
    maxTimePerChat: 20000,   // full mode: 20 s
    scrollPause: 400,
    renderTimeout: 5000,     // full mode: 5 s for messages to appear
    renderTimeoutTest: 1500, // test mode: 1.5 s — typical render is <500 ms
    openTimeout: 3000,
  };

  // ── Message Listener ──
  // Logger has a per-context buffer. We mark already-shipped lines so each
  // response only carries the new lines emitted during that handler.
  let lastShippedLogIndex = 0;

  function pendingLogLines() {
    const all = (typeof Logger !== 'undefined' && Logger.buffer) ? Logger.buffer.lines() : [];
    const next = all.slice(lastShippedLogIndex);
    lastShippedLogIndex = all.length;
    return next;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    log.info('msg.received', { action: message.action });
    handleMessage(message).then(result => {
      const itemCount = (result.chats && result.chats.length) || (result.messages && result.messages.length) || 0;
      log.info('msg.response', { action: message.action, ok: !result.error, items: itemCount, error: result.error });
      // Attach new log lines so the SW can merge them into its master buffer.
      result._cs_logs = pendingLogLines();
      sendResponse(result);
    }).catch(err => {
      log.error('msg.error', { action: message.action, reason: err.message });
      sendResponse({ error: err.message, _cs_logs: pendingLogLines() });
    });
    return true;
  });

  async function handleMessage(message) {
    const { action, payload } = message;

    switch (action) {
      case 'scanInbox':
        abortFlag = false;
        return scanInbox();
      case 'extractChat':
        abortFlag = false;
        return extractChat(payload.chatKey, payload.settings, payload.displayName);
      case 'abortExtraction':
        abortFlag = true;
        log.warn('abort.signaled', { reason: 'user-cancel' });
        return { ok: true };
      case 'diagnose':
        return runDiagnostics();
      default:
        return { error: `Unknown action: ${action}` };
    }
  }

  // ── Scan Inbox ──
  // Scrolls through the conversation list, accumulating chats as LinkedIn
  // may virtualize the list (removing DOM elements that scroll out of view).

  async function scanInbox() {
    log.info('scanInbox.start', { platform: platformId });

    const listContainer = queryWithFallback(document, SEL.conversationList);
    if (!listContainer) {
      log.error('scanInbox.noList', { primary: SEL.conversationList?.primary, fallback: SEL.conversationList?.fallback });
      return { error: 'Cannot find conversation list. Make sure you are on the messaging page.', selectorBroken: true };
    }

    // Accumulate chats by chatKey as we scroll — both LinkedIn and WhatsApp
    // virtualise the chat list (DOM elements get removed as they scroll out
    // of view), so a single end-of-scroll snapshot would miss the early
    // entries. Map-based collection is deduplication-by-construction.
    const chats = await scrollAndCollectChats(listContainer);

    if (chats.length === 0) {
      log.error('scanInbox.empty', {
        primary: SEL.conversationItem?.primary,
        fallback: SEL.conversationItem?.fallback,
      });
      return {
        error: 'No conversations found. Selector may need updating, or scroll the list first.',
        selectorBroken: true,
        chats: [],
      };
    }

    log.info('scanInbox.done', { count: chats.length, platform: platformId });
    return { chats, platform: platformId };
  }

  async function scrollAndCollectChats(listContainer) {
    const scrollContainer = queryWithFallback(document, SEL.conversationListScrollContainer)
      || listContainer.closest('.msg-conversations-container')
      || listContainer.parentElement;

    // Reset to top so re-running Scan after a partial manual scroll is deterministic.
    if (scrollContainer) scrollContainer.scrollTop = 0;
    await sleep(300);

    const collected = new Map(); // chatKey -> chat data
    collectVisibleChats(listContainer, collected);

    if (!scrollContainer) return Array.from(collected.values());

    const maxAttempts = 100;
    const scrollPause = 400;
    const scrollStep = 300;
    let attempts = 0;
    let stableRounds = 0;
    let lastCount = collected.size;

    while (attempts < maxAttempts) {
      if (abortFlag) {
        log.warn('scanInbox.aborted', { round: attempts, collected: collected.size });
        break;
      }

      scrollContainer.scrollTop += scrollStep;
      await sleep(scrollPause);

      collectVisibleChats(listContainer, collected);
      log.info('scanInbox.scroll', { round: attempts, collected: collected.size });

      if (collected.size === lastCount) {
        stableRounds++;
        if (stableRounds >= 5) break;
      } else {
        stableRounds = 0;
      }

      lastCount = collected.size;
      attempts++;
    }

    // Scroll back to top for a clean state.
    scrollContainer.scrollTop = 0;
    return Array.from(collected.values());
  }

  function collectVisibleChats(listContainer, collected) {
    const items = queryAllWithFallback(listContainer, SEL.conversationItem);
    if (items.length === 0) {
      // Fallback: broader search
      const broadItems = queryAllWithFallback(document, SEL.conversationItem);
      for (const el of broadItems) {
        const chat = parseChatItem(el);
        if (chat && !collected.has(chat.chatKey)) {
          collected.set(chat.chatKey, chat);
        }
      }
      return;
    }
    for (const el of items) {
      const chat = parseChatItem(el);
      if (chat && !collected.has(chat.chatKey)) {
        collected.set(chat.chatKey, chat);
      }
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

  async function extractChat(chatKey, settings, displayName) {
    const mode = settings?.extractMode === 'full' ? 'full' : 'test';
    const senderName = settings?.senderName || 'Kate Kondrateva';
    // Test mode is meant for "does this work at all?" — 3 messages is enough
    // to verify the format. Full mode is unbounded.
    const testLimit = 3;
    let state = State.OPEN_CHAT;
    const startTime = Date.now();
    const debug = [];

    log.info('extractChat.start', { chatKey, mode, hasDisplayName: !!displayName });

    try {
      // ── OPEN_CHAT ──
      if (state === State.OPEN_CHAT) {
        _prevMessageFingerprint = getMessageFingerprint();
        const opened = await openChat(chatKey, displayName);
        if (abortFlag) {
          log.warn('extractChat.aborted', { chatKey, stage: 'open' });
          return { error: 'Aborted', chatKey, aborted: true };
        }
        if (!opened) {
          log.warn('extractChat.openFail', { chatKey });
          return { error: 'Could not open chat', chatKey };
        }
        state = State.WAIT_RENDER;
      }

      // ── WAIT_RENDER ──
      if (state === State.WAIT_RENDER) {
        const rendered = await waitForMessages(mode === 'test' ? LIMITS.renderTimeoutTest : LIMITS.renderTimeout);
        if (abortFlag) {
          log.warn('extractChat.aborted', { chatKey, stage: 'render' });
          return { error: 'Aborted', chatKey, aborted: true };
        }
        if (!rendered) {
          debug.push('waitForMessages timed out');
          log.warn('extractChat.renderTimeout', { chatKey });
          return { error: 'Messages did not render in time', chatKey, debug };
        }
        state = State.SCROLL_TOP;
      }

      // ── SCROLL_TOP (only in full mode — test mode skips to keep things fast) ──
      if (state === State.SCROLL_TOP) {
        if (mode === 'full') {
          await scrollToLoadMore(startTime);
          if (abortFlag) {
            log.warn('extractChat.aborted', { chatKey, stage: 'scroll' });
            return { error: 'Aborted', chatKey, aborted: true };
          }
        }
        state = State.COLLECT;
      }

      // ── COLLECT ──
      if (state === State.COLLECT) {
        const contactName = getContactNameFromHeader() || chatKeyToName(chatKey);
        const allMessages = collectMessages(senderName, contactName, chatKey);
        debug.push(`all=${allMessages.length}`);

        // Mode-based selection — no senderName filter (the previous behaviour
        // was the source of "0 messages" when senderName didn't match).
        let selected;
        if (typeof Extractor !== 'undefined' && Extractor.selectMessagesForMode) {
          selected = Extractor.selectMessagesForMode(allMessages, mode, { testLimit });
        } else {
          selected = mode === 'full' ? allMessages.slice() : allMessages.slice(-testLimit);
        }

        log.info('extractChat.collected', {
          chatKey,
          mode,
          total: allMessages.length,
          returned: selected.length,
        });

        return {
          messages: selected,
          allMessages: allMessages.slice(0, Math.max(60, testLimit * 3)),
          chatKey,
          total: allMessages.length,
          collected: selected.length,
          partial: false,
          mode,
          debug,
        };
      }
    } catch (err) {
      log.error('extractChat.error', { chatKey, reason: err.message });
      return { error: err.message, chatKey, debug };
    }

    return { error: 'Unexpected state', chatKey, debug };
  }

  // ── State Machine Helpers ──

  /**
   * Find and click a chat item in the conversation list.
   *
   * Three strategies, in priority order:
   *   1. href match — for LinkedIn / Sales Navigator where each item is an
   *      <a href="/messaging/thread/...">.
   *   2. name match in currently rendered items — fast path.
   *   3. scroll-to-find — for WhatsApp / Telegram which virtualise the list:
   *      items off-screen are removed from the DOM, so we have to scroll the
   *      list incrementally and re-check after each scroll.
   *
   * The previous implementation only did (1) and a strict equality (2), which
   * is why WhatsApp produced "Could not find chat ... Skipping." for almost
   * every chat after the first — by the time the loop reached chat #2, the
   * list had scrolled and chat #2's <li> had been recycled.
   */
  async function openChat(chatKey, providedDisplayName) {
    // Strategy 1 — href-based (LinkedIn / Sales Navigator)
    {
      const items = queryAllWithFallback(document, SEL.conversationItem);
      for (const item of items) {
        if (abortFlag) return false;
        const link = queryWithFallback(item, SEL.conversationItemLink);
        if (link && link.href && link.href.includes(chatKey)) {
          link.click();
          await waitForChatSwitch(800);
          return true;
        }
      }
    }

    // Strategy 2/3 use a fuzzy name match. Source of truth for the target
    // name is the displayName captured at scan time (passed through from SW).
    // Falls back to chatKeyToName(slug) if not available.
    const targetName = cleanText(providedDisplayName) || chatKeyToName(chatKey);

    const matcher = (typeof Extractor !== 'undefined' && Extractor.matchesChatName)
      ? Extractor.matchesChatName
      : function (cands, t) {
          const tl = String(t).toLowerCase();
          for (const c of cands) {
            if (!c) continue;
            const cl = String(c).toLowerCase();
            if (cl === tl || cl.includes(tl) || tl.includes(cl)) return true;
          }
          return false;
        };

    const tryFindAndClick = () => {
      const items = queryAllWithFallback(document, SEL.conversationItem);
      for (const item of items) {
        const candidates = [];
        const titleEls = item.querySelectorAll('span[title]');
        titleEls.forEach((el) => {
          candidates.push(el.getAttribute('title'));
          candidates.push(el.textContent);
        });
        item.querySelectorAll('span[dir="auto"]').forEach((el) => candidates.push(el.textContent));
        const nameEl = queryWithFallback(item, SEL.conversationItemName);
        if (nameEl) {
          candidates.push(nameEl.textContent);
          if (nameEl.getAttribute) candidates.push(nameEl.getAttribute('title'));
        }

        if (matcher(candidates, targetName)) {
          const clickTarget = item.querySelector('div[role="button"]')
            || item.querySelector('a')
            || item;
          clickTarget.click();
          return true;
        }
      }
      return false;
    };

    // Strategy 2 — try without scrolling.
    if (tryFindAndClick()) {
      await waitForChatSwitch(800);
      return true;
    }

    // Strategy 3 — scroll the conversation list looking for the chat.
    const listContainer = queryWithFallback(document, SEL.conversationList);
    if (listContainer) {
      const scrollTarget = listContainer.closest('[style*="overflow"]')
        || listContainer.parentElement
        || listContainer;

      // Reset to top so search is deterministic.
      scrollTarget.scrollTop = 0;
      await sleep(300);

      const maxScrolls = 40;
      for (let i = 0; i < maxScrolls; i++) {
        if (abortFlag) return false;
        if (tryFindAndClick()) {
          await waitForChatSwitch(800);
          log.info('openChat.foundAfterScroll', { chatKey, scrolls: i });
          return true;
        }
        const before = scrollTarget.scrollTop;
        scrollTarget.scrollBy(0, scrollTarget.clientHeight || 400);
        await sleep(300);
        // If the scroll position didn't change, we're at the bottom.
        if (scrollTarget.scrollTop === before) break;
      }
    }

    log.warn('openChat.notFound', { chatKey, target: targetName });
    return false;
  }

  /**
   * Wait for the chat-area DOM to swap after a chat-list click. Returns as
   * soon as the message fingerprint changes from the previous chat OR after
   * `maxMs` elapses. Replaces the unconditional sleep(1500) — which dominated
   * total runtime — with an adaptive wait that's typically 100-300 ms.
   */
  async function waitForChatSwitch(maxMs) {
    const before = _prevMessageFingerprint;
    const deadline = Date.now() + (maxMs || 800);
    while (Date.now() < deadline) {
      if (abortFlag) return;
      const now = getMessageFingerprint();
      if (now && now !== before) return;
      // Some platforms render the new chat header before its messages.
      // Detect by header text change as a fallback signal.
      const header = getContactNameFromHeader() || document.querySelector('#main header')?.textContent;
      if (header) {
        // Header present: 100 ms grace then return.
        await sleep(100);
        return;
      }
      await sleep(50);
    }
  }

  async function waitForMessages(timeoutMs) {
    const deadline = Date.now() + (timeoutMs || LIMITS.renderTimeout);

    // For Sales Navigator: wait for the message content to CHANGE from
    // the previous chat (prevents reading stale DOM from the prior chat)
    if (platformId === 'sales_navigator') {
      while (Date.now() < deadline) {
        if (abortFlag) return false;
        const currentFp = getMessageFingerprint();
        const dataXEls = document.querySelectorAll('[data-x-message-content]');

        if (dataXEls.length > 0 && currentFp !== _prevMessageFingerprint) {
          return true;
        }
        if (!_prevMessageFingerprint && dataXEls.length > 0) {
          return true;
        }

        await sleep(300);
      }
      const dataXEls = document.querySelectorAll('[data-x-message-content]');
      if (dataXEls.length > 0) return true;
      return false;
    }

    // Standard LinkedIn / other platforms
    while (Date.now() < deadline) {
      if (abortFlag) return false;
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
      if (abortFlag) break;
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

  /**
   * WhatsApp Web — parse data-pre-plain-text for timestamp + sender.
   * Format: "[12:34, 5/4/2024] Sender Name: " (or "You: " for own messages).
   * The actual message body is inside `span.copyable-text`.
   */
  function collectMessagesWhatsapp(senderName, contactName, chatKey) {
    const messages = [];
    const messageEls = document.querySelectorAll('#main div.message-in, #main div.message-out');
    log.info('whatsapp.extract', { count: messageEls.length });

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

      // Body: prefer span.copyable-text inside the bubble; fall back to the
      // wrapper's text minus the meta string (handles non-text attachments).
      let bodyEl = el.querySelector('span.copyable-text');
      if (!bodyEl) bodyEl = meta;
      const text = cleanText(bodyEl?.textContent);
      if (!text) continue;

      const finalSender = isMine
        ? senderName
        : (parsedSender && parsedSender.toLowerCase() !== 'you' ? parsedSender : contactName);

      messages.push({
        platform: platform.csvPlatformName,
        messageDateRaw: timestamp,
        sender: finalSender,
        receiver: isMine ? contactName : senderName,
        text,
        chatKey,
      });
    }
    return messages;
  }

  function collectMessages(senderName, contactName, chatKey) {
    if (platformId === 'whatsapp') {
      return collectMessagesWhatsapp(senderName, contactName, chatKey);
    }

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
