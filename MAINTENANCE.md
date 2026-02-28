# Chat Export — Maintenance Guide

## When LinkedIn (or other platforms) Change Their UI

All DOM selectors are centralized in **`selectors.js`**. This is the ONLY file you need to update when a platform changes its HTML structure.

## Selector Architecture

Each selector has two strategies:

```js
{
  primary: '[role="list"]',           // Semantic / aria-based (more stable)
  fallback: '.msg-conversations-list' // Structural / class-based (brittle)
}
```

The extraction code always tries `primary` first, then `fallback`.

## How to Update Selectors

### Step 1: Identify What Broke

Open the browser DevTools on the messaging page and check:
1. Has the class name changed?
2. Has the DOM structure changed?
3. Are aria roles/labels still present?

### Step 2: Find New Selectors

Use DevTools to inspect the element and find:
1. **Preferred**: `role`, `aria-label`, `data-*` attributes
2. **Acceptable**: Class names (LinkedIn uses BEM-like naming: `.msg-s-*`)
3. **Last resort**: Structural paths (tag chains)

### Step 3: Update `selectors.js`

Edit the appropriate platform section in `PLATFORM_SELECTORS`:

```js
// Example: LinkedIn changed the conversation list class
PLATFORM_SELECTORS.linkedin.conversationList = {
  primary: '[role="list"]',                    // Still works? Keep it
  fallback: '.new-classname-for-conv-list',    // Update this
};
```

### Step 4: Test

1. Reload the extension (`chrome://extensions/` → refresh icon)
2. Open the messaging page
3. Click Scan Inbox — verify conversations appear
4. Process a chat — verify messages are extracted

## Selector Reference by Platform

### LinkedIn (`selectors.js` → `PLATFORM_SELECTORS.linkedin`)

| Selector Key           | What It Targets                              | Where to Look in DevTools            |
|-----------------------|----------------------------------------------|--------------------------------------|
| `conversationList`    | The scrollable list of conversations          | Sidebar `<ul>` or `[role="list"]`    |
| `conversationItem`    | Individual conversation row                   | `<li>` items inside the list         |
| `conversationItemName`| Contact name inside a row                     | `<span>` with participant names      |
| `conversationItemPreview`| Last message preview                       | `<span>` with snippet text           |
| `conversationItemTime`| Timestamp on the conversation row             | `<time>` or `<span>` with date       |
| `conversationItemLink`| Clickable link to open the conversation       | `<a>` with `/messaging/thread/` href |
| `messageList`         | Container holding all messages in a chat      | Main area `<ul>` or `<div>`          |
| `messageItem`         | Individual message bubble                     | `<li>` or `<div>` per message        |
| `messageSenderName`   | Sender name in a message group                | `<span>` with profile name           |
| `messageBody`         | Message text content                          | `<p>` or `<span>` with message body  |
| `messageTimestamp`    | Time of a message or message group            | `<time>` element                     |
| `messageGroup`        | Group of sequential messages by same sender   | Wrapper `<div>` for message cluster  |
| `messageScrollContainer`| Scrollable container for messages           | `<div>` with overflow scroll         |

### Adding a New Platform

1. Add platform metadata to `PLATFORMS` in `selectors.js`
2. Add selectors to `PLATFORM_SELECTORS` following the same shape
3. Add content script match pattern in `manifest.json`
4. The content script (`content_script.js`) auto-detects the platform — no changes needed there

## Common LinkedIn Class Patterns

LinkedIn uses BEM-like naming. When classes change, look for:
- `msg-conversations-container__*` → conversation sidebar
- `msg-conversation-listitem__*` → conversation row items
- `msg-s-message-*` → message thread elements
- `msg-s-event-*` → individual message events
- `msg-overlay-*` → overlay/popup message windows

## Running Tests After Changes

```bash
node tests/test_anonymize.js
node tests/test_csv.js
```

These test the data pipeline (anonymization + CSV). Selector changes don't affect these tests — manual testing on the actual platform is needed.

## Manual Test Checklist

After updating selectors:

- [ ] Scan Inbox: finds ≥1 conversation
- [ ] Conversation names display correctly
- [ ] Select a chat → Process → messages extracted
- [ ] Sender vs receiver attribution is correct
- [ ] Timestamps are captured
- [ ] Export CSV → opens in Excel/Sheets correctly
- [ ] Anonymized export → contacts replaced with CONTACT_XXXX
- [ ] PII redaction works (test with a message containing an email)
