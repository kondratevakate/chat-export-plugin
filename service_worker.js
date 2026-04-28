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

// Import utility scripts into service worker scope.
// selectors.js MUST be imported here too — startProcessing and
// inspectActiveTab call detectPlatformFromUrl/detectPageInfo, which only
// exist after selectors.js runs in the SW global scope.
importScripts('utils/logger.js', 'utils/extractor.js', 'utils/anonymize.js', 'utils/csv.js', 'utils/redact.js', 'selectors.js');

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

    case 'inspectActiveTab':
      return inspectActiveTab();

    case 'captureDomSample':
      return captureDomSample();

    case 'autoDetectSelectors':
      return autoDetectSelectors(payload);

    case 'setApiKey':
      // Use chrome.storage.session — memory-only, cleared on browser close.
      // The previous chrome.storage.local persisted the key unencrypted to
      // disk, which violates the "no data leaves your browser" promise the
      // moment the laptop is shared, sync'd, or imaged. Session storage is
      // the right tradeoff: re-enter once per browser session, but never
      // sits in a file.
      await chrome.storage.session.set({ anthropicApiKey: payload?.apiKey || '' });
      // Clean up any leaked legacy copy.
      await chrome.storage.local.remove(['anthropicApiKey']);
      return { ok: true };

    case 'getApiKey':
      return new Promise((resolve) => {
        chrome.storage.session.get(['anthropicApiKey'], (r) => resolve({ apiKey: r.anthropicApiKey || '' }));
      });

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
  const stored = await chrome.storage.local.get(['scannedChats', 'scannedPlatform']);
  const chatMeta = {};
  if (stored.scannedChats && Array.isArray(stored.scannedChats)) {
    for (const c of stored.scannedChats) {
      if (c && c.chatKey) chatMeta[c.chatKey] = c.displayName || '';
    }
  }
  log.info('processQueue.metaLoaded', { mappedNames: Object.keys(chatMeta).length });

  // Refuse to start if the active tab's platform doesn't match the platform
  // these chats were scanned from. Otherwise we'd send Sales Nav chatKeys
  // to a LinkedIn-messaging tab and every openChat would fail silently.
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const activePlatform = activeTab ? detectPlatformFromUrl(activeTab.url || '') : null;
  if (stored.scannedPlatform && activePlatform && stored.scannedPlatform !== activePlatform) {
    isProcessing = false;
    log.error('processQueue.platformMismatch', {
      scannedPlatform: stored.scannedPlatform,
      activePlatform,
      activeUrl: activeTab?.url || '',
    });
    return {
      error: `Platform mismatch: your saved chats are from ${stored.scannedPlatform}, but the active tab is ${activePlatform}. Switch to the right tab and try again — or click Scan to refresh chats from this tab.`,
    };
  }

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
        // Cancel-race guard: extractChat may have completed AFTER the user
        // clicked Cancel. Don't append to extractedMessages in that case —
        // the partial run is still useful (downloadable) but we don't want
        // a chat the user explicitly cancelled to land in the CSV.
        if (!isProcessing) {
          log.warn('processQueue.cancelRace', { chatKey, dropped: result.messages.length });
          broadcastProgress({ status: 'cancelled' });
          return;
        }
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

// ── Active-tab inspection ──
//
// inspectActiveTab tells the side panel what's loaded in front of the user
// and whether this plugin can scrape it. Lets us show "WhatsApp Web detected,
// Scan will read your chat list" vs "Slack isn't supported yet — capture a
// DOM sample to send to the developer".
//
// captureDomSample injects a self-contained probe into ANY active tab (uses
// activeTab permission + chrome.scripting.executeScript on user gesture) and
// returns a structured summary suitable for authoring new selectors.

async function inspectActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return { error: 'No active tab.' };
    const info = detectPageInfo(tab.url || '');
    const platform = info.platform ? PLATFORMS[info.platform] : null;
    return {
      url: tab.url,
      title: tab.title,
      // legacy fields (kept for backward compat with older side panels)
      platformId: info.platform,
      platformLabel: platform ? platform.label : null,
      supported: info.ready === true,
      // new rich descriptor — drives the smart banner
      pageType: info.pageType,
      pageLabel: info.label,
      recommend: info.recommend,
      ready: info.ready,
    };
  } catch (err) {
    return { error: 'inspectActiveTab failed: ' + err.message };
  }
}

async function captureDomSample() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return { error: 'No active tab.' };
    if (tab.url && /^(chrome|edge|brave|about|chrome-extension):/.test(tab.url)) {
      return { error: 'Cannot inspect browser-internal pages.' };
    }
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: domProbeFn,
    });
    if (!result) return { error: 'Probe returned no result.' };
    log.info('inspect.captured', {
      url: result.url,
      roles: Object.keys(result.roles || {}).length,
      clusters: result.clusters?.length || 0,
    });
    const markdown = buildInspectionMarkdown(result);
    return {
      ok: true,
      sample: result,
      markdown,
      filename: `dom-sample_${slugifyHost(result.url)}_${dateStamp()}.md`,
    };
  } catch (err) {
    return { error: 'Could not inspect page: ' + err.message };
  }
}

function slugifyHost(url) {
  try { return new URL(url).hostname.replace(/[^a-z0-9]/gi, '-'); }
  catch { return 'page'; }
}

// ── Auto-detect selectors via Claude API ──
//
// Sends the current page's DOM probe to Claude with a small system prompt
// asking for fresh selectors when the existing ones return 0 matches.
// One-shot: probe → API → apply → report. The user can re-click for
// another iteration if the first try misses.

async function autoDetectSelectors(_payload) {
  // 1. Get API key (session storage — memory only)
  const stored = await new Promise((resolve) =>
    chrome.storage.session.get(['anthropicApiKey'], resolve)
  );
  const apiKey = stored.anthropicApiKey;
  if (!apiKey) {
    return { error: 'No Anthropic API key set. Open Advanced settings and paste a key (sk-ant-...).' };
  }

  // The api.anthropic.com host permission must be requested from the side
  // panel (user-gesture context) — chrome.permissions.request from a SW
  // throws "This function must be called during a user gesture". The side
  // panel calls 'requestAnthropicHostPermission' before this action.
  const hasHostPerm = await chrome.permissions.contains({ origins: ['https://api.anthropic.com/*'] });
  if (!hasHostPerm) {
    return {
      error: 'Permission to call api.anthropic.com is required. Click "Auto-detect" again — Chrome will prompt for the host permission.',
      needsHostPermission: true,
    };
  }

  // 2. Capture current DOM probe
  const probeResult = await captureDomSample();
  if (probeResult.error) return { error: 'Could not probe page: ' + probeResult.error };
  const probe = probeResult.sample;

  // 3. Detect current platform from URL
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const platformId = tab ? detectPlatformFromUrl(tab.url || '') : null;

  // 4. Build prompt + call Claude
  const systemPrompt = `You are a DOM selector author for a Chrome extension that scrapes messaging UIs.
Given a structural DOM probe of a page, you propose CSS selectors that find:
- conversationList:        the container of the chat list
- conversationItem:        each individual chat row (repeats N times)
- conversationItemName:    the contact / chat name inside one row
- conversationItemPreview: the last-message preview inside one row
- conversationItemLink:    the clickable link/button to open the chat
- messageList:             the container of messages inside an open chat
- messageItem:             each individual message bubble
- messageBody:             the text content of a message
- messageSenderName:       the author of a message
- messageTimestamp:        the timestamp of a message

Each selector has a primary (preferred — semantic / aria / data-*) and a fallback (structural / class).
Return ONLY a single JSON object. Do not include markdown fences or commentary.

Schema:
{
  "platform": "<the platform id>",
  "selectors": {
    "conversationList":        { "primary": "...", "fallback": "..." },
    "conversationItem":        { "primary": "...", "fallback": "..." },
    "conversationItemName":    { "primary": "...", "fallback": "..." },
    "conversationItemPreview": { "primary": "...", "fallback": "..." },
    "conversationItemLink":    { "primary": "...", "fallback": "..." },
    "messageList":             { "primary": "...", "fallback": "..." },
    "messageItem":             { "primary": "...", "fallback": "..." },
    "messageBody":             { "primary": "...", "fallback": "..." },
    "messageSenderName":       { "primary": "...", "fallback": "..." },
    "messageTimestamp":        { "primary": "...", "fallback": "..." }
  },
  "rationale": "1-2 sentences"
}`;

  // Trim probe to keep token cost reasonable.
  const probeText = buildInspectionMarkdown(probe).slice(0, 60000);
  const userPrompt = `Platform id (if known): ${platformId || 'unknown'}
URL: ${tab?.url || '(unknown)'}

DOM probe:
${probeText}`;

  log.info('autoDetect.callStart', { platformId, urlHost: tab ? new URL(tab.url).hostname : null });

  let proposed;
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });
    if (!resp.ok) {
      const errBody = await resp.text();
      log.error('autoDetect.apiError', { status: resp.status, body: errBody.slice(0, 500) });
      return { error: `Claude API error ${resp.status}: ${errBody.slice(0, 200)}` };
    }
    const data = await resp.json();
    const text = data.content?.[0]?.text || '';
    // Strip code fences if Claude added them.
    const jsonText = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    proposed = JSON.parse(jsonText);
  } catch (err) {
    log.error('autoDetect.exception', { reason: err.message });
    return { error: 'Auto-detect failed: ' + err.message };
  }

  if (!proposed?.selectors) {
    return { error: 'Claude returned no selectors block.' };
  }

  log.info('autoDetect.received', { platform: proposed.platform, keys: Object.keys(proposed.selectors).length });

  // 5. Test the proposed selectors in the tab — count matches per selector.
  let counts = {};
  try {
    // runs-in-tab:start
    const testFn = (sel) => {
      const out = {};
      for (const [key, pair] of Object.entries(sel)) {
        const p = (pair && pair.primary) ? document.querySelectorAll(pair.primary).length : 0;
        const f = (pair && pair.fallback) ? document.querySelectorAll(pair.fallback).length : 0;
        out[key] = { primary: p, fallback: f };
      }
      return out;
    };
    // runs-in-tab:end
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: testFn,
      args: [proposed.selectors],
    });
    counts = result || {};
  } catch (err) {
    log.warn('autoDetect.testFail', { reason: err.message });
  }

  return {
    ok: true,
    platform: proposed.platform || platformId,
    selectors: proposed.selectors,
    rationale: proposed.rationale || '',
    counts,
  };
}

/**
 * Self-contained DOM probe — runs in the active tab via chrome.scripting.
 * MUST NOT close over outer scope (chrome.scripting serialises the function).
 * Pure: no DOM mutation, no network, no PII in output (collects shapes,
 * counts, and small structural HTML snippets — message text bodies are
 * trimmed to length-only stats).
 *
 * runs-in-tab:start
 * ↑ This marker tells tests/unit/mv3-guard.test.js that everything below
 * runs in the page context (where DOM exists), not in the SW. DOM API
 * usage between the start/end markers is intentional and not a bug.
 */
function domProbeFn() {
  const out = {
    url: location.href,
    title: document.title || '',
    timestamp: new Date().toISOString(),
  };

  // 1. Roles in use (excellent first signal — most modern apps use ARIA).
  const roles = {};
  document.querySelectorAll('[role]').forEach((el) => {
    const r = el.getAttribute('role');
    roles[r] = (roles[r] || 0) + 1;
  });
  out.roles = roles;

  // 2. Most common data-* attributes (often platform-specific markers).
  const dataAttrs = {};
  const allEls = document.querySelectorAll('*');
  for (const el of allEls) {
    for (const attr of el.attributes) {
      if (attr.name.startsWith('data-')) {
        dataAttrs[attr.name] = (dataAttrs[attr.name] || 0) + 1;
      }
    }
  }
  out.dataAttrs = Object.entries(dataAttrs)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .reduce((m, [k, v]) => { m[k] = v; return m; }, {});

  // 3. Repeating clusters: parents whose children share a tag/role/class
  // signature — likely chat lists, message lists, post feeds.
  const clusters = [];
  document.querySelectorAll('*').forEach((parent) => {
    const children = Array.from(parent.children || []);
    if (children.length < 3) return;
    const sigs = new Map();
    for (const c of children) {
      const cls = (typeof c.className === 'string' ? c.className : c.className?.baseVal || '')
        .split(/\s+/).filter(Boolean).slice(0, 2).join('.');
      const sig = c.tagName + '|' + (c.getAttribute('role') || '') + '|' + cls;
      sigs.set(sig, (sigs.get(sig) || 0) + 1);
    }
    const dominant = [...sigs.entries()].sort((a, b) => b[1] - a[1])[0];
    if (dominant && dominant[1] >= 3) {
      const cls = (typeof parent.className === 'string' ? parent.className : '')
        .split(/\s+/).filter(Boolean).slice(0, 3);
      clusters.push({
        parentTag: parent.tagName,
        parentRole: parent.getAttribute('role') || null,
        parentId: parent.id || null,
        parentClasses: cls,
        childPattern: dominant[0],
        childCount: dominant[1],
      });
    }
  });
  out.clusters = clusters
    .sort((a, b) => b.childCount - a.childCount)
    .slice(0, 10);

  // 4a. SDUI screens — LinkedIn's new framework labels each rendered surface
  // with a stable identifier. Tells us if the active page actually rendered
  // messaging vs. feed (the previous capture mistakenly grabbed the feed
  // surface from a messaging URL because the right pane dominated).
  const sduiScreens = {};
  document.querySelectorAll('[data-sdui-screen]').forEach((el) => {
    const v = el.getAttribute('data-sdui-screen');
    sduiScreens[v] = (sduiScreens[v] || 0) + 1;
  });
  out.sduiScreens = sduiScreens;

  // 4b. Top data-testid values — modern apps deliberately expose these for
  // testability and they survive UI redesigns better than CSS classes.
  const testIds = {};
  document.querySelectorAll('[data-testid]').forEach((el) => {
    const v = el.getAttribute('data-testid');
    testIds[v] = (testIds[v] || 0) + 1;
  });
  out.testIds = Object.entries(testIds)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .reduce((m, [k, v]) => { m[k] = v; return m; }, {});

  // 4c. Top aria-label values — often human-readable ("Conversation with X",
  // "Open chat", "Post analytics"). Aria-labels frequently include personal
  // names ("Message Effie Guo", "Conversation with Sarah Mubarak") which
  // would land in shareable Markdown reports. Filter values that look
  // person-specific BEFORE counting, so the resulting top-N is structural.
  const isLikelyPersonalAriaLabel = (s) => {
    // Email or phone — definite PII.
    if (/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(s)) return true;
    if (/\+?\d[\d\s().-]{6,}\d/.test(s)) return true;
    // Patterns that are usually structural ("View 12 reactions", "Like",
    // "Open menu"): keep. Patterns like "Conversation with X", "Message X",
    // "View X's profile" embed a name → strip the name to leave the verb.
    return false;
  };
  const stripNameFromAriaLabel = (s) => {
    return s
      .replace(/^(Conversation with|Message|Send a message to|View|Open chat with)\s+.+$/, '$1 <name>')
      .replace(/^(.+)['’]s\s+profile.*$/, '<name>’s profile')
      .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '<email>')
      .replace(/\+?\d[\d\s().-]{6,}\d/g, '<phone>');
  };
  const ariaLabels = {};
  document.querySelectorAll('[aria-label]').forEach((el) => {
    let v = (el.getAttribute('aria-label') || '').slice(0, 60);
    if (!v) return;
    if (isLikelyPersonalAriaLabel(v)) v = stripNameFromAriaLabel(v);
    else v = stripNameFromAriaLabel(v); // also strip name patterns from non-PII labels
    ariaLabels[v] = (ariaLabels[v] || 0) + 1;
  });
  out.ariaLabels = Object.entries(ariaLabels)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .reduce((m, [k, v]) => { m[k] = v; return m; }, {});

  // 4d. SDUI structural componentkey values — LinkedIn assigns stable names
  // like `com.linkedin.sdui.profile.card.Topcard` to its semantic blocks.
  // These survive UI redesigns better than CSS classes.
  const sduiKeys = {};
  document.querySelectorAll('[componentkey]').forEach((el) => {
    const v = el.getAttribute('componentkey') || '';
    // UUIDs are not useful; only keep the structural ones.
    if (/^com\.linkedin\./i.test(v) || /^[a-z][a-zA-Z]*\./.test(v)) {
      // Strip any per-entity URN suffix to find the type.
      const stem = v.split(':')[0].split('-')[0];
      sduiKeys[stem] = (sduiKeys[stem] || 0) + 1;
    }
  });
  out.sduiComponentKeys = Object.entries(sduiKeys)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .reduce((m, [k, v]) => { m[k] = v; return m; }, {});

  // 4e. Sample HTML — every [role="main"] + structural anchors. Snippets up
  // to 5000 chars (the previous 1500 was too short — LinkedIn SDUI pages
  // are 400-500 KB and the topcard alone fills 1500 chars).
  const SNIPPET_MAX = 5000;
  out.samples = [];
  document.querySelectorAll('[role="main"]').forEach((el, idx) => {
    out.samples.push({
      selector: `[role="main"] (instance ${idx + 1})`,
      sduiScreen: el.getAttribute('data-sdui-screen') || null,
      id: el.id || null,
      fullLength: el.outerHTML.length,
      snippet: el.outerHTML.slice(0, SNIPPET_MAX),
    });
  });

  // Sample around "interesting" SDUI components — feed updates (posts),
  // messaging surfaces, profile cards. Lets us see the shape of a single
  // post/message/card without scrolling the dump.
  const interestingPatterns = ['feed.update', 'message', 'thread', 'post', 'analytic', 'reactions'];
  for (const pattern of interestingPatterns) {
    if (out.samples.length >= 8) break;
    const el = document.querySelector(`[componentkey*="${pattern}"]`);
    if (el && !out.samples.some((s) => s.fullLength === el.outerHTML.length)) {
      out.samples.push({
        selector: `[componentkey*="${pattern}"]`,
        componentKey: el.getAttribute('componentkey'),
        fullLength: el.outerHTML.length,
        snippet: el.outerHTML.slice(0, SNIPPET_MAX),
      });
    }
  }

  // Also pick a few list-shaped containers if not already sampled.
  const moreCandidates = [
    '[data-testid="lazy-column"]',
    '[role="list"]', '[role="grid"]', '[role="log"]', '[role="feed"]',
    '#pane-side', '#main',
  ];
  for (const sel of moreCandidates) {
    if (out.samples.length >= 10) break;
    const el = document.querySelector(sel);
    if (el && !out.samples.some((s) => s.fullLength === el.outerHTML.length)) {
      out.samples.push({
        selector: sel,
        fullLength: el.outerHTML.length,
        snippet: el.outerHTML.slice(0, SNIPPET_MAX),
      });
    }
  }

  // 5. CSS-class namespaces (msg-, message-, conversation-, post-, ...).
  const classNamespaces = new Map();
  for (const el of allEls) {
    const cls = typeof el.className === 'string' ? el.className : '';
    for (const c of cls.split(/\s+/)) {
      if (!c) continue;
      const m = c.match(/^([a-z]+[-_])/i);
      if (m) classNamespaces.set(m[1], (classNamespaces.get(m[1]) || 0) + 1);
    }
  }
  out.classNamespaces = [...classNamespaces.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .reduce((m, [k, v]) => { m[k] = v; return m; }, {});

  // 6. Iframes — LinkedIn's new "interop" pattern embeds the legacy posts/
  // analytics UI inside <iframe> elements. Same-origin iframes (linkedin.com
  // → linkedin.com) ARE accessible from content scripts via contentDocument.
  // Capturing what's inside is the only path to extracting analytics numbers,
  // post bodies and per-post engagement counts.
  out.iframes = [];
  document.querySelectorAll('iframe').forEach((iframe) => {
    const entry = {
      src: iframe.src || '(blank)',
      name: iframe.name || iframe.getAttribute('name') || '',
      testid: iframe.getAttribute('data-testid') || null,
      accessible: false,
    };
    try {
      const doc = iframe.contentDocument;
      if (doc && doc.body) {
        entry.accessible = true;
        entry.title = doc.title || '';
        entry.bodyLength = doc.body.innerHTML.length;
        // Roles inside the iframe
        const innerRoles = {};
        doc.querySelectorAll('[role]').forEach((el) => {
          const r = el.getAttribute('role');
          innerRoles[r] = (innerRoles[r] || 0) + 1;
        });
        entry.roles = innerRoles;
        // SDUI / structural componentkey stems
        const innerKeys = {};
        doc.querySelectorAll('[componentkey]').forEach((el) => {
          const v = el.getAttribute('componentkey') || '';
          if (/^com\.linkedin\./.test(v) || /^[a-z][a-zA-Z]*[._]/.test(v)) {
            const stem = v.split(':')[0].split('-')[0];
            innerKeys[stem] = (innerKeys[stem] || 0) + 1;
          }
        });
        entry.componentKeys = Object.entries(innerKeys)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 15)
          .reduce((m, [k, v]) => { m[k] = v; return m; }, {});
        // data-testid distribution inside
        const innerTestIds = {};
        doc.querySelectorAll('[data-testid]').forEach((el) => {
          const v = el.getAttribute('data-testid');
          innerTestIds[v] = (innerTestIds[v] || 0) + 1;
        });
        entry.testIds = Object.entries(innerTestIds)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 20)
          .reduce((m, [k, v]) => { m[k] = v; return m; }, {});
        // First 5000 chars of body — visibility into the actual rendered tree.
        entry.snippet = doc.body.innerHTML.slice(0, 5000);
      }
    } catch (err) {
      entry.error = 'cross-origin or sandboxed: ' + (err && err.message ? err.message : 'access denied');
    }
    out.iframes.push(entry);
  });

  return out;
}
// runs-in-tab:end

/**
 * Render a probe result as a Markdown report. Output is sized to paste
 * into a GitHub issue or a Claude prompt for selector authoring.
 */
function buildInspectionMarkdown(probe) {
  if (!probe || !probe.url) return '';
  const lines = [];
  lines.push(`# DOM inspection — ${probe.url}`);
  lines.push(`captured: ${probe.timestamp}`);
  lines.push(`title: ${probe.title}`);
  lines.push('');

  lines.push('## Roles in use');
  const roles = Object.entries(probe.roles || {}).sort((a, b) => b[1] - a[1]);
  for (const [r, n] of roles) lines.push(`- \`${r}\`: ${n}`);
  lines.push('');

  if (probe.sduiScreens && Object.keys(probe.sduiScreens).length) {
    lines.push('## SDUI screens rendered (LinkedIn-specific)');
    for (const [k, v] of Object.entries(probe.sduiScreens)) {
      lines.push(`- \`${k}\`: ${v}`);
    }
    lines.push('');
  }

  if (probe.sduiComponentKeys && Object.keys(probe.sduiComponentKeys).length) {
    lines.push('## SDUI componentkey stems (top 20)');
    for (const [k, v] of Object.entries(probe.sduiComponentKeys)) {
      lines.push(`- \`${k}\`: ${v}`);
    }
    lines.push('');
  }

  if (probe.testIds && Object.keys(probe.testIds).length) {
    lines.push('## Top data-testid values (top 30)');
    for (const [k, v] of Object.entries(probe.testIds)) {
      lines.push(`- \`${k}\`: ${v}`);
    }
    lines.push('');
  }

  if (probe.ariaLabels && Object.keys(probe.ariaLabels).length) {
    lines.push('## Top aria-label patterns (top 25, truncated to 60 chars)');
    for (const [k, v] of Object.entries(probe.ariaLabels)) {
      lines.push(`- \`${k}\`: ${v}`);
    }
    lines.push('');
  }

  lines.push('## Common data-* attributes (top 30)');
  for (const [k, v] of Object.entries(probe.dataAttrs || {})) {
    lines.push(`- \`${k}\`: ${v}`);
  }
  lines.push('');

  lines.push('## CSS class namespaces (top 15)');
  for (const [k, v] of Object.entries(probe.classNamespaces || {})) {
    lines.push(`- \`${k}*\`: ${v} elements`);
  }
  lines.push('');

  lines.push('## Repeating clusters (likely lists/feeds)');
  (probe.clusters || []).forEach((c, i) => {
    const cls = c.parentClasses?.length ? '.' + c.parentClasses.join('.') : '';
    const role = c.parentRole ? `[role="${c.parentRole}"]` : '';
    const id = c.parentId ? `#${c.parentId}` : '';
    lines.push(`${i + 1}. parent: \`<${c.parentTag.toLowerCase()}${id}${cls}${role}>\``);
    lines.push(`   child pattern: \`${c.childPattern}\` (×${c.childCount})`);
  });
  lines.push('');

  lines.push('## Sample HTML');
  (probe.samples || []).forEach((s) => {
    const meta = [];
    if (s.sduiScreen) meta.push(`sdui-screen="${s.sduiScreen}"`);
    if (s.componentKey) meta.push(`componentkey="${s.componentKey}"`);
    if (s.id) meta.push(`id="${s.id}"`);
    const metaStr = meta.length ? ` ${meta.join(' ')}` : '';
    lines.push(`### \`${s.selector}\`${metaStr} (full length: ${s.fullLength})`);
    lines.push('```html');
    lines.push(s.snippet);
    lines.push('```');
    lines.push('');
  });

  if (probe.iframes && probe.iframes.length) {
    lines.push('## Iframes (LinkedIn "interop" pattern often hides real content here)');
    probe.iframes.forEach((f, i) => {
      lines.push(`### Iframe ${i + 1}`);
      lines.push(`- src: \`${f.src}\``);
      if (f.testid) lines.push(`- data-testid: \`${f.testid}\``);
      if (f.name) lines.push(`- name: \`${f.name}\``);
      lines.push(`- accessible: ${f.accessible ? 'YES (same-origin)' : 'NO (' + (f.error || 'unknown') + ')'}`);
      if (f.accessible) {
        lines.push(`- title: \`${f.title || '(empty)'}\``);
        lines.push(`- body length: ${f.bodyLength}`);
        if (f.roles && Object.keys(f.roles).length) {
          lines.push('- roles inside:');
          for (const [r, n] of Object.entries(f.roles).sort((a, b) => b[1] - a[1])) {
            lines.push(`  - \`${r}\`: ${n}`);
          }
        }
        if (f.componentKeys && Object.keys(f.componentKeys).length) {
          lines.push('- componentkey stems inside:');
          for (const [k, v] of Object.entries(f.componentKeys)) {
            lines.push(`  - \`${k}\`: ${v}`);
          }
        }
        if (f.testIds && Object.keys(f.testIds).length) {
          lines.push('- data-testid inside:');
          for (const [k, v] of Object.entries(f.testIds)) {
            lines.push(`  - \`${k}\`: ${v}`);
          }
        }
        if (f.snippet) {
          lines.push('- body snippet (first 5000 chars):');
          lines.push('```html');
          lines.push(f.snippet);
          lines.push('```');
        }
      }
      lines.push('');
    });
  }

  lines.push('---');
  lines.push('Generated by Chat Export plugin · paste this into a GitHub issue or share with the developer to add support for this site.');
  return lines.join('\n');
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
