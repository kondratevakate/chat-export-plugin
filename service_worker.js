/**
 * service_worker.js — Background orchestrator for LinkedIn Chat Export.
 *
 * Responsibilities:
 * - Relay messages between side panel and content script
 * - Manage queue processing state
 * - Handle CSV export via chrome.downloads
 * - Manage anonymization salt
 */

/* global CSVBuilder, Anonymize, Redact */

// Import utility scripts into service worker scope
importScripts('utils/anonymize.js', 'utils/csv.js', 'utils/redact.js');

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

    case 'processQueue':
      return startProcessing(payload);

    case 'cancelProcessing':
      isProcessing = false;
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
      return { ok: true };

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

async function getLinkedInTab() {
  const tabs = await chrome.tabs.query({ url: '*://*.linkedin.com/messaging/*', active: true });
  if (tabs.length > 0) {
    currentTabId = tabs[0].id;
    return tabs[0];
  }
  // Try any LinkedIn messaging tab
  const allTabs = await chrome.tabs.query({ url: '*://*.linkedin.com/messaging/*' });
  if (allTabs.length > 0) {
    currentTabId = allTabs[0].id;
    return allTabs[0];
  }
  return null;
}

async function forwardToContentScript(action, payload) {
  const tab = await getLinkedInTab();
  if (!tab) {
    return { error: 'No LinkedIn Messaging tab found. Please open linkedin.com/messaging/' };
  }

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { action, payload });
    return response;
  } catch (err) {
    return { error: `Content script not responding: ${err.message}. Try refreshing the LinkedIn page.` };
  }
}

// ── Queue Processing ──

async function startProcessing(payload) {
  if (isProcessing) return { error: 'Already processing' };

  const { selectedChatKeys, excludedChatKeys, mode, settings } = payload;

  runState.selectedChatKeys = selectedChatKeys || [];
  runState.excludedChatKeys = excludedChatKeys || [];
  runState.processedChatKeys = [];
  runState.failures = [];
  extractedMessages = [];
  isProcessing = true;

  // Determine queue based on mode
  const queue = [...runState.selectedChatKeys];

  // Process sequentially — user-triggered, one at a time
  processQueue(queue, settings);

  return { ok: true, queueLength: queue.length };
}

async function processQueue(queue, settings) {
  for (const chatKey of queue) {
    if (!isProcessing) {
      broadcastProgress({ status: 'cancelled' });
      return;
    }

    broadcastProgress({
      status: 'processing',
      current: chatKey,
      processed: runState.processedChatKeys.length,
      total: queue.length,
      failures: runState.failures.length,
    });

    try {
      const result = await forwardToContentScript('extractChat', {
        chatKey,
        settings,
      });

      if (result.error) {
        runState.failures.push({ chatKey, reason: result.error });
      } else if (result.messages) {
        // Apply date filters
        const filtered = filterMessages(result.messages, settings);
        extractedMessages.push(...filtered);
        runState.processedChatKeys.push(chatKey);
      }
    } catch (err) {
      runState.failures.push({ chatKey, reason: err.message });
    }

    // Small delay between chats to avoid appearing bot-like
    if (isProcessing && queue.indexOf(chatKey) < queue.length - 1) {
      await sleep(1500 + Math.random() * 1000);
    }
  }

  isProcessing = false;
  broadcastProgress({
    status: 'done',
    processed: runState.processedChatKeys.length,
    total: queue.length,
    failures: runState.failures.length,
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
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const filename = anonymize
    ? `linkedin_export_anon_${dateStamp()}.csv`
    : `linkedin_export_${dateStamp()}.csv`;

  try {
    await chrome.downloads.download({ url, filename, saveAs: true });
    return { ok: true, count: messages.length };
  } catch (err) {
    return { error: `Download failed: ${err.message}` };
  }
}

function dateStamp() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

// ── Settings ──

async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['settings'], (result) => {
      resolve(result.settings || {
        senderName: 'Kate Kondrateva',
        messagesPerChat: 8,
        rowMode: 'message',
        dateFrom: '',
        dateTo: '',
        redactPII: true,
      });
    });
  });
}

// ── Helpers ──

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
