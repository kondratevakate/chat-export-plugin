/**
 * sidepanel.js — Side panel UI controller.
 *
 * Manages state, user interactions, and communication with service worker.
 */

/* global CSVBuilder, Anonymize, Redact, Logger */

// ── State ──
let scannedChats = [];       // ChatIndexItem[]
let selectedChats = [];      // ChatIndexItem[]
let excludedChats = [];      // ChatIndexItem[]
let currentMode = 'selected'; // 'selected' | 'exclude'
let hasProcessedData = false; // true after successful processing
let isProcessingLocal = false; // mirrors SW state for settings-lock UX

const uiLog = (typeof Logger !== 'undefined' ? Logger.logFor('ui') : { info: console.log, warn: console.warn, error: console.error });

// ── DOM Refs ──
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const els = {
  chatSearch: $('#chatSearch'),
  suggestions: $('#suggestions'),
  selectedChats: $('#selectedChats'),
  excludedChats: $('#excludedChats'),
  excludeSection: $('#excludeSection'),
  dateFrom: $('#dateFrom'),
  dateTo: $('#dateTo'),
  exportFormat: $('#exportFormat'),
  btnScan: $('#btnScan'),
  btnDownload: $('#btnDownload'),
  btnProcess: $('#btnProcess'),
  progressPanel: $('#progressPanel'),
  progressFill: $('#progressFill'),
  progressText: $('#progressText'),
  progressDetails: $('#progressDetails'),
  statusBar: $('#statusBar'),
  scanHint: $('#scanHint'),
  senderName: $('#senderName'),
  rowMode: $('#rowMode'),
  redactPII: $('#redactPII'),
  btnCancel: $('#btnCancel'),
  btnSaveSettings: $('#btnSaveSettings'),
  btnClearData: $('#btnClearData'),
  btnDownloadLog: $('#btnDownloadLog'),
  btnCopyLog: $('#btnCopyLog'),
  logActions: $('#logActions'),
  detectBanner: $('#detectBanner'),
  detectIcon: $('#detectIcon'),
  detectMessage: $('#detectMessage'),
  detectRecommend: $('#detectRecommend'),
  detectUrl: $('#detectUrl'),
  btnInspect: $('#btnInspect'),
  btnRefreshDetect: $('#btnRefreshDetect'),
  inspectPanel: $('#inspectPanel'),
  inspectOutput: $('#inspectOutput'),
  btnCopyInspect: $('#btnCopyInspect'),
  btnDownloadInspect: $('#btnDownloadInspect'),
  btnAutoDetect: $('#btnAutoDetect'),
  autoDetectStatus: $('#autoDetectStatus'),
  anthropicApiKey: $('#anthropicApiKey'),
  matchPanel: $('#matchPanel'),
  matchScanned: $('#matchScanned'),
  matchActive: $('#matchActive'),
  matchStatus: $('#matchStatus'),
  btnSwitchTab: $('#btnSwitchTab'),
};

let lastInspection = null; // { markdown, filename, sample }

// Step sections (for highlighting)
const stepSections = [
  els.btnScan.closest('.step-section'),
  $('#step2Section'),
  els.btnProcess.closest('.step-section'),
  els.btnDownload.closest('.step-section'),
];

// ── Init ──

document.addEventListener('DOMContentLoaded', async () => {
  // Set default "To" date to today
  els.dateTo.value = new Date().toISOString().slice(0, 10);

  // Load API key
  const apiKeyResp = await sendMessage('getApiKey');
  if (apiKeyResp && apiKeyResp.apiKey) {
    els.anthropicApiKey.value = apiKeyResp.apiKey;
  }

  // Load settings
  const settings = await sendMessage('getSettings');
  if (settings && !settings.error) {
    els.senderName.value = settings.senderName || 'Kate Kondrateva';
    els.rowMode.value = settings.rowMode || 'message';
    els.redactPII.checked = settings.redactPII !== false;
    if (settings.dateFrom) els.dateFrom.value = settings.dateFrom;
    if (settings.dateTo) els.dateTo.value = settings.dateTo;
    const wantedMode = settings.extractMode === 'full' ? 'full' : 'test';
    const radio = document.querySelector(`input[name="extractMode"][value="${wantedMode}"]`);
    if (radio) radio.checked = true;
  }

  // Load persisted scanned chats
  chrome.storage.local.get(['scannedChats', 'selectedKeys', 'excludedKeys'], (data) => {
    if (data.scannedChats) {
      scannedChats = data.scannedChats;
    }
    if (data.selectedKeys && scannedChats.length) {
      selectedChats = scannedChats.filter(c => data.selectedKeys.includes(c.chatKey));
      renderChips(els.selectedChats, selectedChats, 'selected');
    }
    if (data.excludedKeys && scannedChats.length) {
      excludedChats = scannedChats.filter(c => data.excludedKeys.includes(c.chatKey));
      renderChips(els.excludedChats, excludedChats, 'excluded');
    }
    updateButtonStates();
    updateStepHighlight();
  });

  bindEvents();
  updateStepHighlight();

  // Detect what's in the active tab and refresh on tab/url change.
  refreshDetectBanner();
  if (chrome.tabs) {
    if (chrome.tabs.onActivated) {
      chrome.tabs.onActivated.addListener(() => refreshDetectBanner());
    }
    if (chrome.tabs.onUpdated) {
      chrome.tabs.onUpdated.addListener((_id, info) => {
        if (info.url || info.status === 'complete') refreshDetectBanner();
      });
    }
  }
});

// ── Event Bindings ──

function bindEvents() {
  // Mode toggle
  $$('input[name="mode"]').forEach(radio => {
    radio.addEventListener('change', () => {
      currentMode = radio.value;
      els.excludeSection.classList.toggle('hidden', currentMode !== 'exclude');
      updateButtonStates();
      updateStepHighlight();
    });
  });

  // Search
  els.chatSearch.addEventListener('input', onSearch);
  els.chatSearch.addEventListener('focus', onSearch);
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.chat-selector')) {
      els.suggestions.classList.add('hidden');
    }
  });

  // Actions
  els.btnScan.addEventListener('click', onScanInbox);
  els.btnProcess.addEventListener('click', onProcessQueue);
  els.btnCancel.addEventListener('click', onCancel);
  els.btnDownload.addEventListener('click', onDownload);
  els.btnDownloadLog.addEventListener('click', onDownloadLog);
  els.btnCopyLog.addEventListener('click', onCopyLog);
  els.btnInspect.addEventListener('click', onInspectPage);
  els.btnRefreshDetect.addEventListener('click', refreshDetectBanner);
  els.btnCopyInspect.addEventListener('click', onCopyInspection);
  els.btnDownloadInspect.addEventListener('click', onDownloadInspection);
  els.btnAutoDetect.addEventListener('click', onAutoDetectSelectors);
  els.btnSwitchTab.addEventListener('click', onSwitchToScannedTab);
  // Persist API key on blur so user doesn't have to click Save.
  els.anthropicApiKey.addEventListener('change', onSaveApiKey);
  els.anthropicApiKey.addEventListener('blur', onSaveApiKey);

  // Settings
  els.btnSaveSettings.addEventListener('click', onSaveSettings);
  els.btnClearData.addEventListener('click', onClearData);

  // Listen for progress updates from service worker
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'progressUpdate') {
      updateProgress(msg.payload);
    }
  });
}

// ── Step Highlight ──

function updateStepHighlight() {
  const hasScanned = scannedChats.length > 0;
  const hasSelection = currentMode === 'exclude'
    ? scannedChats.length > excludedChats.length
    : selectedChats.length > 0;

  // Determine current step (0-indexed)
  let currentStep;
  if (hasProcessedData) {
    currentStep = 3; // Download
  } else if (hasSelection) {
    currentStep = 2; // Process
  } else if (hasScanned) {
    currentStep = 1; // Select chats
  } else {
    currentStep = 0; // Scan
  }

  stepSections.forEach((section, i) => {
    if (!section) return;
    section.classList.remove('active-step', 'done-step');
    if (i < currentStep) {
      section.classList.add('done-step');
    } else if (i === currentStep) {
      section.classList.add('active-step');
    }
  });

  // Enable/disable search based on scan state
  els.chatSearch.disabled = !hasScanned;
  els.chatSearch.placeholder = hasScanned
    ? `Search ${scannedChats.length} chats...`
    : 'Scan inbox first...';

  // Update scan hint
  if (els.scanHint) {
    if (hasScanned) {
      els.scanHint.textContent = `${scannedChats.length} chats found. Now select chats below.`;
    } else {
      els.scanHint.textContent = 'Open LinkedIn Messaging or Sales Navigator Inbox, then click Scan.';
    }
  }
}

// ── Search & Suggestions ──

function onSearch() {
  const query = els.chatSearch.value.trim().toLowerCase();
  if (!query || scannedChats.length === 0) {
    if (scannedChats.length > 0 && !query) {
      showAllSuggestions();
    } else {
      els.suggestions.classList.add('hidden');
    }
    return;
  }

  const alreadySelected = new Set([
    ...selectedChats.map(c => c.chatKey),
    ...excludedChats.map(c => c.chatKey),
  ]);

  const matches = scannedChats.filter(c =>
    !alreadySelected.has(c.chatKey) &&
    c.displayName.toLowerCase().includes(query)
  ).slice(0, 10);

  renderSuggestions(matches);
}

function showAllSuggestions() {
  const alreadySelected = new Set([
    ...selectedChats.map(c => c.chatKey),
    ...excludedChats.map(c => c.chatKey),
  ]);

  const available = scannedChats.filter(c => !alreadySelected.has(c.chatKey)).slice(0, 15);
  renderSuggestions(available);
}

function renderSuggestions(items) {
  if (items.length === 0) {
    els.suggestions.classList.add('hidden');
    return;
  }

  els.suggestions.innerHTML = items.map(chat => `
    <div class="suggestion-item" data-key="${escapeAttr(chat.chatKey)}">
      <div>${escapeHTML(chat.displayName)}</div>
      <div class="preview">${escapeHTML(chat.lastPreview || '')}</div>
    </div>
  `).join('');

  els.suggestions.classList.remove('hidden');

  // Bind click
  els.suggestions.querySelectorAll('.suggestion-item').forEach(el => {
    el.addEventListener('click', () => {
      const key = el.dataset.key;
      const chat = scannedChats.find(c => c.chatKey === key);
      if (!chat) return;

      if (currentMode === 'exclude') {
        if (!excludedChats.find(c => c.chatKey === key)) {
          excludedChats.push(chat);
          renderChips(els.excludedChats, excludedChats, 'excluded');
          persistSelection();
        }
      } else {
        if (!selectedChats.find(c => c.chatKey === key)) {
          selectedChats.push(chat);
          renderChips(els.selectedChats, selectedChats, 'selected');
          persistSelection();
        }
      }

      els.chatSearch.value = '';
      els.suggestions.classList.add('hidden');
      updateButtonStates();
      updateStepHighlight();
    });
  });
}

// ── Chips ──

function renderChips(container, chatList, type) {
  container.innerHTML = chatList.map(chat => `
    <span class="chip ${type === 'excluded' ? 'excluded' : ''}" data-key="${escapeAttr(chat.chatKey)}">
      ${escapeHTML(chat.displayName)}
      <span class="remove" data-key="${escapeAttr(chat.chatKey)}" data-type="${type}">&times;</span>
    </span>
  `).join('');

  container.querySelectorAll('.remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const key = btn.dataset.key;
      if (btn.dataset.type === 'excluded') {
        excludedChats = excludedChats.filter(c => c.chatKey !== key);
        renderChips(els.excludedChats, excludedChats, 'excluded');
      } else {
        selectedChats = selectedChats.filter(c => c.chatKey !== key);
        renderChips(els.selectedChats, selectedChats, 'selected');
      }
      persistSelection();
      updateButtonStates();
      updateStepHighlight();
    });
  });
}

function persistSelection() {
  chrome.storage.local.set({
    selectedKeys: selectedChats.map(c => c.chatKey),
    excludedKeys: excludedChats.map(c => c.chatKey),
  });
}

// ── Actions ──

async function onScanInbox() {
  setStatus('Scanning inbox...', '');
  els.btnScan.disabled = true;
  els.btnScan.textContent = 'Scanning...';

  const result = await sendMessage('scanInbox');

  els.btnScan.disabled = false;
  els.btnScan.textContent = 'Scan Inbox';

  if (result.error) {
    setStatus(result.error, 'error');
    return;
  }

  if (result.chats && result.chats.length > 0) {
    scannedChats = result.chats;
    // Persist the platform alongside the chats so processQueue can verify
    // the active tab is the same kind of page (LinkedIn vs Sales Nav vs
    // WhatsApp). Otherwise stored Sales Nav chatKeys get processed against
    // a LinkedIn messaging tab and every extraction silently fails.
    // Capture the URL of the scanned tab so the mismatch panel can offer a
    // "Switch back" button if the user navigates away.
    let scannedUrl = '';
    try {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      scannedUrl = activeTab?.url || '';
    } catch { /* tabs perm denied or no active tab */ }

    chrome.storage.local.set({
      scannedChats,
      scannedPlatform: result.platform || null,
      scannedAt: Date.now(),
      lastScannedUrl: scannedUrl,
    });
    const platformLabel = result.platform ? ` from ${result.platform}` : '';
    setStatus(`Found ${scannedChats.length} chats${platformLabel}. Now select the ones you need.`, 'success');
  } else {
    setStatus('No conversations found. Make sure you are on the messaging page and scroll to load chats.', 'error');
  }

  updateButtonStates();
  updateStepHighlight();
}

async function onProcessQueue() {
  const settings = gatherSettings();

  let queue;
  if (currentMode === 'exclude') {
    const excludeSet = new Set(excludedChats.map(c => c.chatKey));
    queue = scannedChats.filter(c => !excludeSet.has(c.chatKey)).map(c => c.chatKey);
  } else {
    queue = selectedChats.map(c => c.chatKey);
  }

  if (queue.length === 0) {
    setStatus('No chats to process. Select chats in step 2 first.', 'error');
    return;
  }

  uiLog.info('process.start', { count: queue.length, mode: settings.extractMode });

  // Reset the log buffer for a fresh run so the downloadable file matches
  // exactly this run.
  if (typeof Logger !== 'undefined' && Logger.buffer) {
    Logger.buffer.clear();
  }

  // Show progress and cancel button
  els.progressPanel.classList.remove('hidden');
  els.progressDetails.innerHTML = '';
  els.btnProcess.disabled = true;
  els.btnProcess.classList.add('hidden');
  els.btnCancel.classList.remove('hidden');
  els.btnCancel.disabled = false;
  els.btnCancel.textContent = 'Cancel';
  els.logActions.classList.add('hidden');

  setSettingsLocked(true);
  isProcessingLocal = true;

  const result = await sendMessage('processQueue', {
    selectedChatKeys: queue,
    excludedChatKeys: excludedChats.map(c => c.chatKey),
    mode: currentMode,
    settings,
  });

  if (result.error) {
    if (result.error === 'Already processing') {
      setStatus('A run is already in progress — click Cancel first.', 'error');
    } else {
      setStatus(result.error, 'error');
    }
    setSettingsLocked(false);
    isProcessingLocal = false;
    els.btnProcess.disabled = false;
    els.btnProcess.classList.remove('hidden');
    els.btnCancel.classList.add('hidden');
    els.btnProcess.textContent = 'Process Selected Chats';
    return;
  }

  setStatus(`Processing ${result.queueLength} chats... Please wait.`);
}

async function onCancel() {
  uiLog.warn('process.cancelClicked');
  // Show a "Cancelling..." state immediately so the user knows the click was
  // received. The button stays visible but disabled until the SW broadcasts
  // status: 'cancelled'/'done'.
  els.btnCancel.disabled = true;
  els.btnCancel.textContent = 'Cancelling...';
  await sendMessage('cancelProcessing');
  setStatus('Cancelling — finishing current chat...', 'error');
}

function getLocalLogLines() {
  return (typeof Logger !== 'undefined' && Logger.buffer) ? Logger.buffer.lines() : [];
}

async function onDownloadLog() {
  uiLog.info('log.downloadClicked');
  const result = await sendMessage('downloadLog', { uiLines: getLocalLogLines() });
  if (!result || !result.text) {
    setStatus('Log is empty.', 'error');
    return;
  }
  try {
    const blob = new Blob([result.text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    await chrome.downloads.download({ url, filename: result.filename, saveAs: true });
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    setStatus(`Log saved (${result.text.split('\n').length} lines).`, 'success');
  } catch (err) {
    setStatus('Log download failed: ' + err.message, 'error');
  }
}

async function onCopyLog() {
  uiLog.info('log.copyClicked');
  const result = await sendMessage('getLog', { uiLines: getLocalLogLines() });
  if (!result || !result.text) {
    setStatus('Log is empty.', 'error');
    return;
  }
  try {
    await navigator.clipboard.writeText(result.text);
    setStatus(`Log copied to clipboard (${result.text.split('\n').length} lines).`, 'success');
  } catch (err) {
    // Fallback when clipboard API is blocked: use a hidden textarea + execCommand.
    const ta = document.createElement('textarea');
    ta.value = result.text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      setStatus('Log copied to clipboard.', 'success');
    } catch (err2) {
      setStatus('Could not copy: ' + err2.message, 'error');
    } finally {
      document.body.removeChild(ta);
    }
  }
}

function setSettingsLocked(locked) {
  // Lock controls that would corrupt an in-flight run if changed.
  els.dateFrom.disabled = locked;
  els.dateTo.disabled = locked;
  els.btnScan.disabled = locked;
  els.btnSaveSettings.disabled = locked;
  els.btnClearData.disabled = locked;
  els.senderName.disabled = locked;
  els.rowMode.disabled = locked;
  els.redactPII.disabled = locked;
  document.querySelectorAll('input[name="extractMode"]').forEach(r => { r.disabled = locked; });
  document.querySelectorAll('input[name="mode"]').forEach(r => { r.disabled = locked; });
}

async function onDownload() {
  const format = els.exportFormat.value;
  const action = format === 'csv_anon' ? 'exportAnonCSV' : 'exportCSV';

  setStatus('Preparing export...');
  els.btnDownload.disabled = true;

  try {
    const result = await sendMessage(action);

    if (result.error) {
      setStatus(result.error, 'error');
      return;
    }

    if (!result.csv) {
      setStatus('Export returned no data.', 'error');
      return;
    }

    // Build the blob URL here in the side panel — DOM is available, unlike
    // in the MV3 service worker where URL.createObjectURL is not supported.
    const blob = new Blob([result.csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    try {
      await chrome.downloads.download({ url, filename: result.filename, saveAs: true });
      setStatus(`Exported ${result.count} rows. Done!`, 'success');
    } finally {
      // Revoke after a short delay so chrome.downloads has time to read it.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  } catch (err) {
    setStatus('Download failed: ' + err.message, 'error');
  } finally {
    els.btnDownload.disabled = false;
  }
}

async function onSaveSettings() {
  const settings = gatherSettings();
  await sendMessage('updateSettings', settings);
  setStatus('Settings saved', 'success');
}

async function onClearData() {
  scannedChats = [];
  selectedChats = [];
  excludedChats = [];
  hasProcessedData = false;
  renderChips(els.selectedChats, [], 'selected');
  renderChips(els.excludedChats, [], 'excluded');
  chrome.storage.local.remove(['scannedChats', 'selectedKeys', 'excludedKeys']);
  await sendMessage('clearData');
  els.progressPanel.classList.add('hidden');
  setStatus('All data cleared. Start over with step 1.', 'success');
  updateButtonStates();
  updateStepHighlight();
}

// ── Settings ──

function gatherSettings() {
  const modeRadio = document.querySelector('input[name="extractMode"]:checked');
  const extractMode = (modeRadio && modeRadio.value === 'full') ? 'full' : 'test';
  return {
    senderName: els.senderName.value.trim() || 'Kate Kondrateva',
    extractMode,
    rowMode: els.rowMode.value,
    redactPII: els.redactPII.checked,
    dateFrom: els.dateFrom.value || '',
    dateTo: els.dateTo.value || '',
  };
}

// ── Progress ──

function updateProgress(data) {
  els.progressPanel.classList.remove('hidden');

  const msgCount = data.messageCount || 0;

  if (data.status === 'processing') {
    const pct = data.total > 0 ? Math.round((data.processed / data.total) * 100) : 0;
    els.progressFill.style.width = pct + '%';
    els.progressText.textContent = `Chats: ${data.processed}/${data.total} | Messages: ${msgCount} | Failed: ${data.failures}`;

    const chatName = findChatName(data.current);
    appendProgressDetail(`Processing: ${chatName}...`, '');
  } else if (data.status === 'done') {
    els.progressFill.style.width = '100%';
    els.progressText.textContent = `Done! Chats: ${data.processed}/${data.total} | Messages: ${msgCount} | Failed: ${data.failures}`;
    finishRunUI();
    hasProcessedData = msgCount > 0;
    els.btnDownload.disabled = !hasProcessedData;
    updateStepHighlight();
    if (hasProcessedData) {
      setStatus(`${msgCount} messages ready. Choose format and click Download.`, 'success');
    } else {
      // 0 messages — surface a recovery card BEFORE the technical diagnostics
      // dump. Most users don't want to read DOM HTML; they want a button to
      // press. The technical details remain available below.
      showZeroMessagesRecovery();
      setStatus('No messages found — the page layout may have changed.', 'error');
      runAndShowDiagnostics();
    }
  } else if (data.status === 'cancelled') {
    // Show partial results so the user knows their work isn't lost.
    if (msgCount > 0) {
      els.progressText.textContent = `Cancelled — ${msgCount} messages from ${data.processed} chats are saved.`;
      hasProcessedData = true;
      els.btnDownload.disabled = false;
      setStatus(`Cancelled. ${msgCount} messages saved — Download is below.`, 'success');
    } else {
      els.progressText.textContent = 'Cancelled — no messages extracted.';
      setStatus('Processing cancelled. Log available for download.', 'error');
    }
    finishRunUI();
  }
}

function showZeroMessagesRecovery() {
  // Insert a recovery card at the top of progressDetails before the auto
  // diagnostics dump. Primary CTA: try Auto-fix with Claude.
  const card = document.createElement('div');
  card.className = 'recovery-card';
  card.innerHTML = `
    <div class="recovery-title">⚠️ No messages found on this page</div>
    <div class="recovery-body">The site's layout may have changed since this extractor was last verified. Try one of:</div>
    <div class="recovery-actions"></div>
  `;
  const actions = card.querySelector('.recovery-actions');

  const autoFixBtn = document.createElement('button');
  autoFixBtn.className = 'btn btn-primary half-width';
  autoFixBtn.textContent = '🤖 Auto-fix with Claude';
  autoFixBtn.addEventListener('click', () => {
    // Surface the inspect panel + auto-detect button to the user.
    onInspectPage().then(() => {
      els.btnAutoDetect?.scrollIntoView({ block: 'center' });
    });
  });
  actions.appendChild(autoFixBtn);

  const diagnoseBtn = document.createElement('button');
  diagnoseBtn.className = 'btn btn-secondary half-width';
  diagnoseBtn.textContent = 'Show technical details';
  diagnoseBtn.addEventListener('click', () => {
    els.progressDetails.scrollTop = els.progressDetails.scrollHeight;
  });
  actions.appendChild(diagnoseBtn);

  // Insert at top of progress details.
  els.progressDetails.insertBefore(card, els.progressDetails.firstChild);
}

function finishRunUI() {
  els.btnCancel.classList.add('hidden');
  els.btnCancel.disabled = false;
  els.btnCancel.textContent = 'Cancel';
  els.btnProcess.classList.remove('hidden');
  els.btnProcess.disabled = false;
  els.btnProcess.textContent = 'Process Selected Chats';
  els.logActions.classList.remove('hidden');
  setSettingsLocked(false);
  isProcessingLocal = false;
}

function findChatName(chatKey) {
  const chat = scannedChats.find(c => c.chatKey === chatKey);
  return chat ? chat.displayName : chatKey;
}

function appendProgressDetail(text, className) {
  const div = document.createElement('div');
  div.className = className;
  div.textContent = text;
  els.progressDetails.appendChild(div);
  els.progressDetails.scrollTop = els.progressDetails.scrollHeight;
}

// ── UI Helpers ──

function updateButtonStates() {
  const hasScanned = scannedChats.length > 0;
  const hasSelection = currentMode === 'exclude'
    ? scannedChats.length > excludedChats.length
    : selectedChats.length > 0;

  els.btnProcess.disabled = !hasSelection;
  els.btnProcess.title = hasSelection
    ? ''
    : (hasScanned ? 'Pick at least one chat in Step 2.' : 'Click Scan in Step 1 first.');

  els.btnDownload.disabled = !hasProcessedData;
  els.btnDownload.title = hasProcessedData
    ? ''
    : 'Run extraction first — Download appears after at least one message is collected.';
}

function setStatus(text, type = '') {
  els.statusBar.textContent = text;
  els.statusBar.className = 'status-bar' + (type ? ' ' + type : '');
}

// ── Diagnostics ──

async function runAndShowDiagnostics() {
  const result = await sendMessage('diagnose');
  if (result.error) {
    appendProgressDetail(`Diagnostics failed: ${result.error}`, 'error');
    return;
  }

  appendProgressDetail('--- DOM Diagnostics ---', '');
  appendProgressDetail(`Platform: ${result.platform} | URL: ${result.url}`, '');

  // Show selector matches
  if (result.selectors) {
    for (const [key, info] of Object.entries(result.selectors)) {
      appendProgressDetail(`  ${key}: ${info.primary} / ${info.fallback}`, '');
    }
  }

  // Show found CSS classes
  if (result.msgClasses && result.msgClasses.length > 0) {
    appendProgressDetail(`msg-classes: ${result.msgClasses.join(', ')}`, '');
  }
  if (result.messageClasses && result.messageClasses.length > 0) {
    appendProgressDetail(`message-classes: ${result.messageClasses.join(', ')}`, '');
  }

  // Show sample HTML
  if (result.sampleHTML) {
    appendProgressDetail('--- Sample DOM ---', '');
    // Split long text into lines for readability
    const lines = result.sampleHTML.split('\n').slice(0, 30);
    for (const line of lines) {
      appendProgressDetail(line, '');
    }
  }

  setStatus('0 messages. Diagnostics shown in progress panel. Share screenshot with developer.', 'error');
}

// ── Messaging ──

function sendMessage(action, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action, payload }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ error: chrome.runtime.lastError.message });
      } else {
        resolve(response || {});
      }
    });
  });
}

// ── Active-tab detection + inspection ──

async function refreshDetectBanner() {
  setDetectBanner({ icon: '⏳', message: 'Checking active tab…', recommend: '', url: '', state: 'loading' });
  const r = await sendMessage('inspectActiveTab');
  if (!r || r.error) {
    setDetectBanner({ icon: '❓', message: r?.error || 'Could not read active tab.', recommend: '', url: '', state: 'unsupported' });
    applyPageMode(null);
    return;
  }
  // Text prefix in addition to the icon — color-only signals exclude
  // colorblind users and don't survive in screen-reader output.
  let icon, state, prefix;
  if (r.ready === true) { icon = '🟢'; state = 'supported'; prefix = 'Ready: '; }
  else if (r.ready === false) { icon = '⚠️'; state = 'unsupported'; prefix = 'Not supported: '; }
  else { icon = '❓'; state = 'unsupported'; prefix = 'Unknown: '; }
  setDetectBanner({
    icon,
    message: prefix + (r.pageLabel || 'Unknown page'),
    recommend: r.recommend || '',
    url: r.url || '',
    state,
  });
  applyPageMode(r);
  refreshMatchPanel(r);
}

let lastScannedTabUrl = '';

/**
 * Show "scanned X chats from PLATFORM_A · active tab is PLATFORM_B" so a
 * mismatch is visible BEFORE the user clicks Extract. The bug we're guarding
 * against: user scans on Sales Nav, navigates to LinkedIn messaging in the
 * same window, clicks Extract, all 20 chats fail silently because their
 * chatKeys are Sales Nav URNs that don't exist on the messaging page.
 */
async function refreshMatchPanel(activePage) {
  const stored = await new Promise((resolve) => {
    chrome.storage.local.get(['scannedChats', 'scannedPlatform', 'scannedAt', 'lastScannedUrl'], resolve);
  });
  const scannedCount = stored.scannedChats?.length || 0;
  const scannedPlatform = stored.scannedPlatform;
  lastScannedTabUrl = stored.lastScannedUrl || '';

  if (!scannedCount) {
    els.matchPanel.classList.add('hidden');
    return;
  }

  els.matchPanel.classList.remove('hidden');

  // Format the "scanned" line.
  let scannedLine = `${scannedCount} chats`;
  if (scannedPlatform) scannedLine += ` from ${platformLabelFor(scannedPlatform)}`;
  if (stored.scannedAt) {
    const mins = Math.round((Date.now() - stored.scannedAt) / 60000);
    scannedLine += mins < 1 ? ' · just now' : ` · ${mins} min ago`;
  }
  els.matchScanned.textContent = scannedLine;

  // Active tab line.
  els.matchActive.textContent = activePage?.pageLabel || 'Unknown';

  // Match logic.
  const activePlatform = activePage?.platformId;
  els.matchPanel.classList.remove('match-ok', 'match-mismatch');
  els.matchStatus.classList.remove('match-status-ok', 'match-status-mismatch');

  if (activePlatform && scannedPlatform && activePlatform !== scannedPlatform) {
    els.matchPanel.classList.add('match-mismatch');
    els.matchStatus.classList.add('match-status-mismatch');
    els.matchStatus.textContent = `Mismatch: chats are from ${platformLabelFor(scannedPlatform)} but you're on ${platformLabelFor(activePlatform)}.`;
    els.btnProcess.disabled = true;
    els.btnProcess.title = 'Switch to the scanned tab, or click Scan to refresh from this tab.';
    els.btnSwitchTab.classList.toggle('hidden', !lastScannedTabUrl);
  } else if (!scannedPlatform && activePlatform) {
    // Legacy chats persisted before platform tracking landed. Don't
    // pretend the data matches; tell the user to re-scan from the right tab.
    els.matchPanel.classList.add('match-mismatch');
    els.matchStatus.classList.add('match-status-mismatch');
    els.matchStatus.textContent = 'These chats were scanned before platform tracking — re-scan from the right tab to revalidate.';
    els.btnProcess.title = 'Re-scan from the correct tab to refresh the chat list.';
    els.btnSwitchTab.classList.add('hidden');
  } else if (scannedPlatform === activePlatform || (!activePlatform && scannedPlatform)) {
    els.matchPanel.classList.add('match-ok');
    els.matchStatus.classList.add('match-status-ok');
    els.matchStatus.textContent = '✓ Same platform — ready to extract.';
    els.btnProcess.title = '';
    els.btnSwitchTab.classList.add('hidden');
    // Re-enable process if it was disabled by mismatch (selection check below
    // will disable it again if no chats are picked).
    updateButtonStates();
  } else {
    els.matchStatus.textContent = '';
    els.btnSwitchTab.classList.add('hidden');
  }
}

function platformLabelFor(id) {
  const map = {
    sales_navigator: 'Sales Navigator',
    linkedin: 'LinkedIn Messaging',
    whatsapp: 'WhatsApp Web',
    telegram: 'Telegram Web',
    instagram: 'Instagram DMs',
  };
  return map[id] || id;
}

async function onSwitchToScannedTab() {
  if (!lastScannedTabUrl) return;
  const tabs = await chrome.tabs.query({ url: lastScannedTabUrl + '*' });
  if (tabs.length) {
    chrome.tabs.update(tabs[0].id, { active: true });
  } else {
    chrome.tabs.create({ url: lastScannedTabUrl });
  }
}

/**
 * Adjust the Step-1 wording based on the detected page. NEVER disables the
 * button — clicking it on an unsupported page just falls through to the
 * existing scan flow which produces a clear error. Disabling silently
 * confuses users ("button doesn't work anywhere") more than a clickable
 * button that sometimes errors.
 */
function applyPageMode(pageInfo) {
  const scanBtn = els.btnScan;
  const scanHint = els.scanHint;

  // Always keep the button clickable — let the scan attempt itself decide
  // whether the page is scrapable. The detection banner above already tells
  // the user what they're on.
  scanBtn.disabled = false;

  if (!pageInfo) {
    scanBtn.textContent = 'Scan Inbox';
    return;
  }

  const t = pageInfo.pageType;
  if (t === 'sales_inbox') {
    scanBtn.textContent = 'Scan Sales Navigator inbox';
    if (scanHint) scanHint.textContent = 'Reads your conversation list and clicks "Load older conversations" to get the long tail.';
  } else if (t === 'whatsapp_web') {
    scanBtn.textContent = 'Scan WhatsApp chats';
    if (scanHint) scanHint.textContent = 'Reads your chat list. WhatsApp virtualises — we accumulate chats while scrolling.';
  } else if (t === 'telegram_web') {
    scanBtn.textContent = 'Scan Telegram chats';
    if (scanHint) scanHint.textContent = 'Selectors are scaffolded but untested on current Telegram Web. If 0 chats, click Inspect.';
  } else if (t === 'instagram_dms') {
    scanBtn.textContent = 'Scan Instagram DMs';
    if (scanHint) scanHint.textContent = 'Selectors are scaffolded but untested on current Instagram. If 0 chats, click Inspect.';
  } else {
    scanBtn.textContent = 'Scan Inbox';
    if (scanHint) scanHint.textContent = pageInfo.recommend || 'Open a supported messaging tab, then click Scan.';
  }
}

function setDetectBanner({ icon, message, recommend, url, state }) {
  els.detectIcon.textContent = icon;
  els.detectMessage.textContent = message;
  // The recommendation lives on a separate line below the page label.
  if (els.detectRecommend) {
    els.detectRecommend.textContent = recommend || '';
    els.detectRecommend.classList.toggle('hidden', !recommend);
  }
  els.detectUrl.textContent = url ? safeShortenUrl(url) : '';
  els.detectBanner.classList.remove('detect-loading', 'detect-supported', 'detect-unsupported');
  els.detectBanner.classList.add('detect-' + state);
}

function safeShortenUrl(u) {
  try {
    const x = new URL(u);
    return x.hostname + x.pathname;
  } catch {
    return u;
  }
}

async function onInspectPage() {
  uiLog.info('inspect.clicked');
  els.btnInspect.disabled = true;
  els.btnInspect.textContent = 'Diagnosing…';
  try {
    const r = await sendMessage('captureDomSample');
    if (!r || r.error) {
      setStatus(r?.error || 'Diagnose failed.', 'error');
      return;
    }
    lastInspection = r;
    els.inspectOutput.value = r.markdown || '';
    els.inspectPanel.classList.remove('hidden');
    // Move focus to the textarea so screen-reader users hear the result
    // without having to tab back to the top.
    els.inspectOutput.focus();
    setStatus('Page snapshot ready — copy or download below.', 'success');
  } finally {
    els.btnInspect.disabled = false;
    els.btnInspect.textContent = 'Diagnose page';
  }
}

async function onCopyInspection() {
  if (!lastInspection?.markdown) return;
  try {
    await navigator.clipboard.writeText(lastInspection.markdown);
    setStatus('DOM sample copied to clipboard.', 'success');
  } catch (err) {
    setStatus('Could not copy: ' + err.message, 'error');
  }
}

async function onSaveApiKey() {
  const apiKey = els.anthropicApiKey.value.trim();
  await sendMessage('setApiKey', { apiKey });
  if (apiKey) setStatus('API key saved.', 'success');
}

async function onAutoDetectSelectors() {
  uiLog.info('autoDetect.clicked');
  els.btnAutoDetect.disabled = true;
  els.btnAutoDetect.textContent = '🤖 Asking Claude…';
  els.autoDetectStatus.classList.remove('hidden');
  els.autoDetectStatus.textContent = 'Sending DOM probe to Claude…';
  try {
    // chrome.permissions.request must run in user-gesture context. Service
    // workers don't preserve gesture state, so we request the host
    // permission here before delegating the actual API call to the SW.
    const hasPerm = await chrome.permissions.contains({ origins: ['https://api.anthropic.com/*'] });
    if (!hasPerm) {
      els.autoDetectStatus.textContent = 'Requesting permission to call Claude…';
      const granted = await chrome.permissions.request({ origins: ['https://api.anthropic.com/*'] });
      if (!granted) {
        setStatus('Permission denied — Auto-detect needs network access to api.anthropic.com.', 'error');
        els.autoDetectStatus.textContent = '❌ Host permission denied.';
        return;
      }
    }
    els.autoDetectStatus.textContent = 'Sending DOM probe to Claude…';
    const result = await sendMessage('autoDetectSelectors', {});
    if (result.error) {
      setStatus(result.error, 'error');
      els.autoDetectStatus.textContent = '❌ ' + result.error;
      return;
    }
    // Render counts as Markdown-ish text.
    const lines = [`✅ Got selectors for platform "${result.platform}"`, ''];
    if (result.rationale) lines.push(result.rationale, '');
    lines.push('Match counts on this page:');
    for (const [key, c] of Object.entries(result.counts || {})) {
      const total = (c.primary || 0) + (c.fallback || 0);
      const flag = total > 0 ? '✓' : '✗';
      lines.push(`${flag} ${key}: primary=${c.primary || 0}, fallback=${c.fallback || 0}`);
    }
    lines.push('', '--- Proposed selectors (paste into selectors.js) ---');
    lines.push(JSON.stringify({ [result.platform]: result.selectors }, null, 2));
    els.inspectOutput.value = lines.join('\n');
    els.autoDetectStatus.textContent = '✅ Done — review the result above.';
    setStatus('Claude proposed selectors. See inspection panel.', 'success');
  } catch (err) {
    setStatus('Auto-detect failed: ' + err.message, 'error');
    els.autoDetectStatus.textContent = '❌ ' + err.message;
  } finally {
    els.btnAutoDetect.disabled = false;
    els.btnAutoDetect.textContent = '🤖 Auto-detect selectors with Claude';
  }
}

async function onDownloadInspection() {
  if (!lastInspection?.markdown) return;
  try {
    const blob = new Blob([lastInspection.markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    await chrome.downloads.download({ url, filename: lastInspection.filename || 'dom-sample.md', saveAs: true });
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    setStatus('DOM sample saved.', 'success');
  } catch (err) {
    setStatus('Download failed: ' + err.message, 'error');
  }
}

// ── Sanitization ──

function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
