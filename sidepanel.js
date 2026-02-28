/**
 * sidepanel.js — Side panel UI controller.
 *
 * Manages state, user interactions, and communication with service worker.
 */

/* global CSVBuilder, Anonymize, Redact */

// ── State ──
let scannedChats = [];       // ChatIndexItem[]
let selectedChats = [];      // ChatIndexItem[]
let excludedChats = [];      // ChatIndexItem[]
let currentMode = 'selected'; // 'selected' | 'exclude'
let hasProcessedData = false; // true after successful processing

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
  messagesPerChat: $('#messagesPerChat'),
  rowMode: $('#rowMode'),
  redactPII: $('#redactPII'),
  btnSaveSettings: $('#btnSaveSettings'),
  btnClearData: $('#btnClearData'),
};

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

  // Load settings
  const settings = await sendMessage('getSettings');
  if (settings && !settings.error) {
    els.senderName.value = settings.senderName || 'Kate Kondrateva';
    els.messagesPerChat.value = settings.messagesPerChat || 8;
    els.rowMode.value = settings.rowMode || 'message';
    els.redactPII.checked = settings.redactPII !== false;
    if (settings.dateFrom) els.dateFrom.value = settings.dateFrom;
    if (settings.dateTo) els.dateTo.value = settings.dateTo;
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
});

// ── Event Bindings ──

function bindEvents() {
  // Tabs
  $$('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach(t => t.classList.remove('active'));
      $$('.tab-content').forEach(tc => tc.classList.remove('active'));
      tab.classList.add('active');
      $(`#tab-${tab.dataset.tab}`).classList.add('active');
    });
  });

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
  els.btnDownload.addEventListener('click', onDownload);

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
    chrome.storage.local.set({ scannedChats });
    setStatus(`Found ${scannedChats.length} chats. Now select the ones you need.`, 'success');
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
    // Process all scanned except excluded
    const excludeSet = new Set(excludedChats.map(c => c.chatKey));
    queue = scannedChats.filter(c => !excludeSet.has(c.chatKey)).map(c => c.chatKey);
  } else {
    queue = selectedChats.map(c => c.chatKey);
  }

  if (queue.length === 0) {
    setStatus('No chats to process. Select chats in step 2 first.', 'error');
    return;
  }

  // Show progress
  els.progressPanel.classList.remove('hidden');
  els.progressDetails.innerHTML = '';
  els.btnProcess.disabled = true;
  els.btnProcess.textContent = 'Processing...';

  const result = await sendMessage('processQueue', {
    selectedChatKeys: queue,
    excludedChatKeys: excludedChats.map(c => c.chatKey),
    mode: currentMode,
    settings,
  });

  if (result.error) {
    setStatus(result.error, 'error');
    els.btnProcess.disabled = false;
    els.btnProcess.textContent = 'Process Selected Chats';
    return;
  }

  setStatus(`Processing ${result.queueLength} chats... Please wait.`);
}

async function onDownload() {
  const format = els.exportFormat.value;
  const action = format === 'csv_anon' ? 'exportAnonCSV' : 'exportCSV';

  setStatus('Preparing export...');
  els.btnDownload.disabled = true;

  const result = await sendMessage(action);

  els.btnDownload.disabled = false;

  if (result.error) {
    setStatus(result.error, 'error');
  } else {
    setStatus(`Exported ${result.count} rows. Done!`, 'success');
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
  return {
    senderName: els.senderName.value.trim() || 'Kate Kondrateva',
    messagesPerChat: parseInt(els.messagesPerChat.value, 10) || 8,
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
    els.btnProcess.disabled = false;
    els.btnProcess.textContent = 'Process Selected Chats';
    hasProcessedData = msgCount > 0;
    els.btnDownload.disabled = !hasProcessedData;
    updateStepHighlight();
    if (hasProcessedData) {
      setStatus(`${msgCount} messages ready. Choose format and click Download.`, 'success');
    } else {
      setStatus('0 messages extracted. Check that Sender Name in Settings matches your LinkedIn name. Also try refreshing the LinkedIn page.', 'error');
    }
  } else if (data.status === 'cancelled') {
    els.progressText.textContent = 'Cancelled';
    els.btnProcess.disabled = false;
    els.btnProcess.textContent = 'Process Selected Chats';
  }
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
  els.btnDownload.disabled = !hasProcessedData;
}

function setStatus(text, type = '') {
  els.statusBar.textContent = text;
  els.statusBar.className = 'status-bar' + (type ? ' ' + type : '');
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

// ── Sanitization ──

function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
