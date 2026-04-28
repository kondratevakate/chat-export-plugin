/**
 * service_worker.js — Background orchestrator for LinkedIn Chat Export.
 *
 * Responsibilities:
 * - Relay messages between side panel and content script
 * - Manage queue processing state
 * - Handle CSV export via chrome.downloads
 * - Manage anonymization salt
 */

/* global CSVBuilder, Anonymize, Redact, Logger, Extractor */

// Import utility scripts into service worker scope
importScripts('utils/logger.js', 'utils/extractor.js', 'utils/anonymize.js', 'utils/csv.js', 'utils/redact.js');

const log = Logger.logFor('sw');

// ── State ──

let extractedMessages = [];
let runState = {
  selectedChatKeys: [],
  excludedChatKeys: [],
  processedChatKeys: [],
  failures: [],
};
let isProcessing = false;
let currentTabId = null;

// ── Lifecycle ──

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// ── Message Router ──

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch(err => {
    console.error('[SW] Error handling message:', err);
    sendResponse({ error: err.message });
  });
  return true; // async response
});

async function handleMessage(message, sender) {
  const { action, payload } = message;

  switch (action) {
    // ── From Side Panel ──
    case 'scanInbox':
      return forwardToContentScript('scanInbox', payload);

    case 'diagnose':
      return forwardToContentScript('diagnose', payload);

    case 'processQueue':
      return startProcessing(payload);

    case 'cancelProcessing':
      isProcessing = false;
      log.warn('processQueue.cancelRequested', { pendingChats: runState.selectedChatKeys.length - runState.processedChatKeys.length });
      // Forward abort to the in-flight content script so it stops mid-extraction
      // instead of running the full maxTimePerChat budget.
      forwardToContentScript('abortExtraction').catch(() => { /* tab may have closed */ });
      return { ok: true };

    case 'exportCSV':
      return exportToFile(false);

    case 'exportAnonCSV':
      return exportToFile(true);

    case 'getState':
      return {
        runState,
        extractedMessages: extractedMessages.length,
        isProcessing,
      };

    case 'updateSettings':
      await chrome.storage.local.set({ settings: payload });
      return { ok: true };

    case 'getSettings':
      return getSettings();

    case 'clearData':
      extractedMessages = [];
      runState = {
        selectedChatKeys: [],
        excludedChatKeys: [],
        processedChatKeys: [],
        failures: [],
      };
      await chrome.storage.local.remove(['extractedMessages', 'lastRunLog']);
      return { ok: true };

    case 'getLog':
      return { text: buildMergedLogText(payload?.uiLines) };

    case 'downloadLog':
      // Side panel does the actual chrome.downloads call (it has DOM and
      // therefore Blob/URL.createObjectURL). We just hand back the merged text.
      return { text: buildMergedLogText(payload?.uiLines), filename: `chat-export-log_${dateStamp()}.txt` };

    // ── From Content Script ──
    case 'scanResult':
      return { ok: true }; // Handled via direct response

    case 'extractionResult':
      return handleExtractionResult(payload);

    default:
      return { error: `Unknown action: ${action}` };
  }
}

// ── Content Script Communication ──

// All URL patterns where content scripts are injected (must match manifest.json).
const CONTENT_SCRIPT_PATTERNS = [
  '*://*.linkedin.com/messaging/*',
  '*://*.linkedin.com/sales/inbox/*',
  '*://*.instagram.com/direct/*',
  '*://web.whatsapp.com/*',
  '*://web.telegram.org/*',
];

async function getActiveTab() {
  // Try active tabs first, then any matching tab.
  for (const pattern of CONTENT_SCRIPT_PATTERNS) {
    const tabs = await chrome.tabs.query({ url: pattern, active: true });
    if (tabs.length > 0) {
      currentTabId = tabs[0].id;
      return tabs[0];
    }
  }
  for (const pattern of CONTENT_SCRIPT_PATTERNS) {
    const tabs = await chrome.tabs.query({ url: pattern });
    if (tabs.length > 0) {
      currentTabId = tabs[0].id;
      return tabs[0];
    }
  }
  return null;
}

function mergeCsLogsIntoBuffer(response) {
  if (response && Array.isArray(response._cs_logs) && Logger && Logger.buffer) {
    for (const line of response._cs_logs) Logger.buffer.push(line);
    delete response._cs_logs;
  }
}

async function forwardToContentScript(action, payload) {
  const tab = await getActiveTab();
  if (!tab) {
    return { error: 'No supported messaging tab found. Open LinkedIn Messaging, Sales Navigator Inbox, Instagram DMs, WhatsApp Web, or Telegram Web.' };
  }

  log.info('forward.start', { action, tabId: tab.id });

  // Try sending directly first.
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { action, payload });
    mergeCsLogsIntoBuffer(response);
    return response;
  } catch {
    // Content script not loaded — will inject below.
  }

  // Inject content script programmatically (utils first so Logger/Extractor
  // are available to selectors.js and content_script.js).
  console.log(`[SW] Content script not loaded on tab ${tab.id}, injecting...`);
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['utils/logger.js', 'utils/extractor.js', 'selectors.js', 'content_script.js'],
    });
  } catch (injectErr) {
    console.error(`[SW] Failed to inject content script:`, injectErr);
    return { error: 'Could not inject content script. Try refreshing the page.' };
  }

  // Retry with increasing delays — the freshly injected script needs time
  // to register its chrome.runtime.onMessage listener.
  for (const delay of [500, 1000, 2000]) {
    await sleep(delay);
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { action, payload });
      mergeCsLogsIntoBuffer(response);
      return response;
    } catch {
      console.log(`[SW] Retry after ${delay}ms — content script not ready yet`);
    }
  }

  return { error: 'Content script not responding after injection. Try refreshing the page.' };
}

// ── Queue Processing ──

async function startProcessing(payload) {
  if (isProcessing) {
    log.warn('processQueue.alreadyRunning', { pending: runState.selectedChatKeys.length - runState.processedChatKeys.length });
    return { error: 'Already processing' };
  }

  const { selectedChatKeys, excludedChatKeys, mode, settings } = payload;

  runState.selectedChatKeys = selectedChatKeys || [];
  runState.excludedChatKeys = excludedChatKeys || [];
  runState.processedChatKeys = [];
  runState.failures = [];
  extractedMessages = [];
  isProcessing = true;

  // Build chatKey -> displayName map from persisted scan results so that
  // the content script can find a chat in a virtualised list (WhatsApp,
  // Telegram) without re-deriving the displayName from the slugified key.
  const stored = await chrome.storage.local.get(['scannedChats']);
  const chatMeta = {};
  if (stored.scannedChats && Array.isArray(stored.scannedChats)) {
    for (const c of stored.scannedChats) {
      if (c && c.chatKey) chatMeta[c.chatKey] = c.displayName || '';
    }
  }
  log.info('processQueue.metaLoaded', { mappedNames: Object.keys(chatMeta).length });

  const queue = [...runState.selectedChatKeys];

  // Process sequentially — user-triggered, one at a time
  processQueue(queue, settings, chatMeta);

  return { ok: true, queueLength: queue.length };
}

async function processQueue(queue, settings, chatMeta) {
  log.info('processQueue.start', { total: queue.length, mode: settings?.extractMode || 'test' });

  for (const chatKey of queue) {
    if (!isProcessing) {
      log.warn('processQueue.cancelled', { processed: runState.processedChatKeys.length, remaining: queue.length - runState.processedChatKeys.length });
      broadcastProgress({ status: 'cancelled' });
      return;
    }

    broadcastProgress({
      status: 'processing',
      current: chatKey,
      processed: runState.processedChatKeys.length,
      total: queue.length,
      failures: runState.failures.length,
      messageCount: extractedMessages.length,
    });

    try {
      const result = await forwardToContentScript('extractChat', {
        chatKey,
        displayName: (chatMeta && chatMeta[chatKey]) || '',
        settings,
      });

      if (result.error) {
        log.warn('processQueue.chatError', { chatKey, reason: result.error });
        runState.failures.push({ chatKey, reason: result.error });

        // If content script disconnected, stop — all further chats will fail too
        if (result.error.includes('not responding') || result.error.includes('does not exist') || result.error.includes('Could not establish')) {
          log.error('processQueue.contentScriptLost', { chatKey });
          isProcessing = false;
          broadcastProgress({
            status: 'done',
            processed: runState.processedChatKeys.length,
            total: queue.length,
            failures: runState.failures.length,
            messageCount: extractedMessages.length,
          });
          return;
        }
        // If aborted by user cancel, stop the loop too — the next iteration's
        // !isProcessing guard would handle it, but logging here is cleaner.
        if (result.aborted) {
          log.warn('processQueue.abortedDuringChat', { chatKey });
          broadcastProgress({ status: 'cancelled' });
          return;
        }
      } else if (result.messages) {
        // Apply date filters in the SW (content script doesn't know dates).
        const filtered = filterMessages(result.messages, settings);
        extractedMessages.push(...filtered);
        runState.processedChatKeys.push(chatKey);
        log.info('processQueue.chatDone', {
          chatKey,
          total: result.total || 0,
          collected: result.collected || 0,
          afterDateFilter: filtered.length,
          mode: result.mode || settings?.extractMode || 'test',
        });
      }
    } catch (err) {
      log.error('processQueue.exception', { chatKey, reason: err.message });
      runState.failures.push({ chatKey, reason: err.message });
    }

    // Inter-chat delay — mode-dependent:
    //   test mode: 200-400 ms (cold run should feel instant)
    //   full mode: 1500-2500 ms (avoids rate-limit / bot detection)
    // In both cases poll isProcessing so Cancel takes effect within ~50 ms
    // rather than the full delay.
    if (queue.indexOf(chatKey) < queue.length - 1) {
      const isTestMode = (settings?.extractMode !== 'full');
      const targetWait = isTestMode
        ? (200 + Math.random() * 200)
        : (1500 + Math.random() * 1000);
      const deadline = Date.now() + targetWait;
      while (Date.now() < deadline) {
        if (!isProcessing) break;
        await sleep(50);
      }
    }
  }

  isProcessing = false;

  // Persist messages so data survives service worker restart
  await chrome.storage.local.set({ extractedMessages });
  log.info('processQueue.done', {
    total: queue.length,
    processed: runState.processedChatKeys.length,
    failures: runState.failures.length,
    messages: extractedMessages.length,
  });

  broadcastProgress({
    status: 'done',
    processed: runState.processedChatKeys.length,
    total: queue.length,
    failures: runState.failures.length,
    messageCount: extractedMessages.length,
  });
}

function filterMessages(messages, settings) {
  if (!settings) return messages;

  return messages.filter(msg => {
    if (settings.dateFrom || settings.dateTo) {
      const msgDate = parseLooseDate(msg.messageDateRaw);
      if (msgDate) {
        if (settings.dateFrom && msgDate < new Date(settings.dateFrom)) return false;
        if (settings.dateTo && msgDate > new Date(settings.dateTo + 'T23:59:59')) return false;
      }
    }
    return true;
  });
}

function parseLooseDate(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

function broadcastProgress(data) {
  chrome.runtime.sendMessage({ action: 'progressUpdate', payload: data }).catch(() => {
    // Side panel may not be listening — that's fine
  });
}

// ── Export ──

async function exportToFile(anonymize) {
  // Restore from storage if service worker restarted and lost in-memory data
  if (extractedMessages.length === 0) {
    const stored = await chrome.storage.local.get(['extractedMessages']);
    if (stored.extractedMessages && stored.extractedMessages.length > 0) {
      extractedMessages = stored.extractedMessages;
      console.log(`[SW] Restored ${extractedMessages.length} messages from storage`);
    }
  }

  if (extractedMessages.length === 0) {
    return { error: 'No messages to export. Process some chats first.' };
  }

  const settings = await getSettings();
  let messages = [...extractedMessages];

  if (anonymize) {
    const salt = await Anonymize.getOrCreateSalt();
    messages = await Promise.all(messages.map(async (msg) => {
      const anonReceiver = await Anonymize.anonymizeContact(msg.receiver, salt);
      let text = msg.text;
      if (settings.redactPII) {
        text = Redact.redactPII(text);
      }
      return { ...msg, receiver: anonReceiver, text };
    }));
  }

  if (settings.rowMode === 'conversation') {
    messages = CSVBuilder.mergeByConversation(messages);
  }

  const csv = CSVBuilder.buildCSV(messages);
  const filename = anonymize
    ? `linkedin_export_anon_${dateStamp()}.csv`
    : `linkedin_export_${dateStamp()}.csv`;

  // MV3 service workers cannot create Blob: URLs (URL.createObjectURL throws).
  // Return the CSV body and the side panel — which has a real DOM — does the
  // Blob → object URL → chrome.downloads.download dance.
  return { ok: true, csv, filename, count: messages.length };
}

function dateStamp() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

// ── Settings ──

async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['settings'], (result) => {
      const stored = result.settings || {};
      // Backwards-compat: drop the old messagesPerChat field if present and
      // map missing extractMode to a sensible default ('test' = quick run).
      const merged = {
        senderName: stored.senderName || 'Kate Kondrateva',
        extractMode: stored.extractMode === 'full' ? 'full' : 'test',
        rowMode: stored.rowMode || 'message',
        dateFrom: stored.dateFrom || '',
        dateTo: stored.dateTo || '',
        redactPII: stored.redactPII !== false,
      };
      resolve(merged);
    });
  });
}

// ── Log assembly ──

/**
 * Merge log buffers from all three contexts into a single chronologically
 * sorted text. Each line starts with HH:MM:SS so a lex sort matches a time
 * sort within the same day (good enough for a single run).
 *
 *  - SW buffer:     accumulated locally + CS lines forwarded via _cs_logs
 *  - uiLines:       passed in by the side panel from its own Logger.buffer
 *
 * Duplicate lines (CS line forwarded twice through different responses) are
 * collapsed.
 */
function buildMergedLogText(uiLines) {
  const swLines = (Logger && Logger.buffer) ? Logger.buffer.lines() : [];
  const ui = Array.isArray(uiLines) ? uiLines : [];
  const combined = swLines.concat(ui);
  // Stable sort by leading timestamp; ties keep insertion order.
  const indexed = combined.map((line, i) => ({ line, i }));
  indexed.sort((a, b) => {
    const ta = a.line.slice(0, 8);
    const tb = b.line.slice(0, 8);
    if (ta !== tb) return ta < tb ? -1 : 1;
    return a.i - b.i;
  });
  // Dedupe consecutive duplicates.
  const out = [];
  for (const { line } of indexed) {
    if (out.length === 0 || out[out.length - 1] !== line) out.push(line);
  }
  return out.join('\n') + '\n';
}

// ── Helpers ──

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
