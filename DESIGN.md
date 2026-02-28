# LinkedIn Chat Export — Design Document

## 1. Overview

A privacy-first Chrome Extension (Manifest V3) that exports LinkedIn messages to CSV.
All data stays local. No network calls, no external APIs, no cloud storage.

## 2. UX Flow

### Side Panel Layout (top → bottom)

```
┌─────────────────────────────────┐
│  LinkedIn Chat Export           │
├─────────────────────────────────┤
│  Settings                       │
│  ┌─ Sender Name: [Kate K.]    │
│  ├─ Messages per chat: [8]     │
│  ├─ Row mode: ● per-msg ○ conv │
│  ├─ Date from: [____] to:[____]│
│  └─ Anon salt: [auto]          │
├─────────────────────────────────┤
│  Mode: ● Selected │ ○ Exclude  │
├─────────────────────────────────┤
│  Search: [___________________] │
│  Suggestions:                   │
│   ☐ Alice   ☐ Bob   ☐ Carol   │
├─────────────────────────────────┤
│  Selected (3):                  │
│   Alice [×]  Bob [×]  Carol [×]│
├─────────────────────────────────┤
│  Excluded (1):                  │
│   Dave [×]                      │
├─────────────────────────────────┤
│  [Scan Inbox] [Process Queue]  │
│  [Export CSV] [Export Anon CSV] │
├─────────────────────────────────┤
│  Progress:                      │
│  ✓ Alice  ✓ Bob  ⏳ Carol      │
│  Processed: 2 / Queued: 3      │
│  Failed: 0                      │
└─────────────────────────────────┘
```

### User Workflow

1. Navigate to `linkedin.com/messaging`
2. Open extension side panel
3. Click **Scan Inbox** — content script reads visible conversation list
4. Search/select contacts → they appear in Selected list
5. Adjust settings (N, date range, row mode)
6. Click **Process Queue** — extension opens each chat, extracts messages
7. Click **Export CSV** or **Export Anon CSV** to download

## 3. Extraction State Machine

Each chat goes through these states:

```
IDLE → OPEN_CHAT → WAIT_RENDER → SCROLL_TOP_LIMITED → COLLECT → DONE
                                                              ↓
                                                           FAILED
```

| State              | Action                                          | Timeout  |
|--------------------|------------------------------------------------|----------|
| OPEN_CHAT          | Click conversation in sidebar                   | 3s       |
| WAIT_RENDER        | Poll until message container appears             | 5s       |
| SCROLL_TOP_LIMITED | Scroll up to load older messages (optional)      | 20s max  |
| COLLECT            | Walk DOM, collect messages, filter by sender/date| —        |
| DONE               | Store results, advance queue                     | —        |
| FAILED             | Log reason, advance queue                        | —        |

### Scroll Limits
- `maxScrollAttempts`: 25
- `maxTimePerChat`: 20 seconds
- `scrollPauseBetween`: 400ms
- If limit hit → mark chat "partial" and continue

## 4. Selector Strategy

Two tiers to survive LinkedIn UI changes:

### Primary: Semantic selectors
- Conversation list: `[role="list"]` inside messaging panel
- Conversation item: `[role="listitem"]` or `li` with conversation data
- Message thread: elements with `aria-label` containing message context
- Individual messages: `[data-message-id]` or role-based discovery

### Fallback: Structural selectors
- `.msg-conversations-container__conversations-list`
- `.msg-s-message-list-content`
- `.msg-s-event-listitem`

All selectors live in `selectors.js` for easy maintenance.

## 5. Data Model

```
ChatIndexItem {
  chatKey: string        // unique id from DOM or URL fragment
  displayName: string
  lastPreview: string
  lastActivityHint: string
  profileUrl?: string
}

ExtractedMessage {
  platform: "Linkedin"
  messageDateRaw: string
  sender: string
  receiver: string
  text: string
  chatKey: string
}

RunState {
  selectedChatKeys: string[]
  excludedChatKeys: string[]
  processedChatKeys: string[]
  failures: { chatKey: string, reason: string }[]
}
```

## 6. Anonymization

- Generate a random `localSalt` (stored in chrome.storage.local, never exported)
- `anonId = HMAC-SHA256(displayName, localSalt)` → `CONTACT_` + first 8 hex chars
- Optional PII redaction: regex replacement of emails, phones, URLs in message text

## 7. Export Format

CSV columns (strict order):
```
Platform | Message Date | Sender | Receiver | Message Text
```

- Encoding: UTF-8 with BOM for Excel compatibility
- Field quoting: RFC 4180 compliant
- Message text truncated to 500 characters

## 8. Failure Modes & Mitigations

| Failure                        | Mitigation                                    |
|-------------------------------|-----------------------------------------------|
| Chat doesn't open             | Timeout → mark failed, continue queue         |
| Messages don't render         | Retry once, then mark failed                  |
| Not enough messages found     | Export what we have, mark "partial"            |
| LinkedIn DOM changed          | Fallback selectors; clear error in progress    |
| User navigates away           | Pause queue, resume when back on messaging     |
| Extension reloaded            | RunState persisted in chrome.storage.local     |

## 9. Permissions (Minimal)

- `activeTab` — interact with current LinkedIn tab
- `sidePanel` — show side panel UI
- `storage` — persist state locally
- `downloads` — save CSV files
- Host: `*://*.linkedin.com/*` — content script injection

## 10. File Tree

```
chat-export-plugin/
├── manifest.json
├── service_worker.js
├── sidepanel.html
├── sidepanel.js
├── sidepanel.css
├── content_script.js
├── selectors.js
├── utils/
│   ├── anonymize.js
│   ├── csv.js
│   └── redact.js
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── tests/
│   ├── test_anonymize.js
│   └── test_csv.js
├── DESIGN.md
├── SETUP.md
└── MAINTENANCE.md
```
