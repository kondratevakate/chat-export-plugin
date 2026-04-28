# Contributing

Thanks for thinking about contributing. The most valuable contribution this project gets is **a new platform** — every messenger has a slightly different DOM, and one person can't keep up with all of them.

This guide walks through:

1. [Setting up a dev environment](#dev-setup)
2. [Adding a new messenger](#adding-a-new-messenger) — the main use case
3. [Updating selectors when a platform changes](#updating-selectors)
4. [Other ways to contribute](#other-contributions)
5. [Submitting your PR](#submitting-a-pr)

---

## Dev setup

```bash
git clone https://github.com/kondratevakate/chat-export-plugin
cd chat-export-plugin
npm install   # only needed for tests
```

Load the extension into Chrome:

1. `chrome://extensions/` → enable **Developer mode**
2. **Load unpacked** → pick the repo folder
3. Pin the icon, open the side panel, you're in

After every code change: hit the **reload** icon on the extension card (or `Ctrl+R` in `chrome://extensions/`). Refresh the messaging tab too — content scripts are injected at page load.

Run the test suite:

```bash
npm test         # one-shot, used by CI
npm run test:watch   # while iterating
```

---

## Adding a new messenger

Adding a platform is ~5 files and 30-100 lines depending on how weird the DOM is. The project is designed so the IIFE in `content_script.js` is platform-agnostic — you mostly add selectors and an optional custom extractor.

### Step 1 — Capture a DOM fixture (5 minutes)

Open the messenger in your browser. We need two snapshots:

**A. The chat list panel** (for `scanInbox` to find conversations):
1. Open DevTools (F12)
2. Find the element that wraps the *whole* sidebar/chat list
3. Right-click → **Copy → Copy outerHTML**
4. Save to `tests/fixtures/<platform>-list_YYYY-MM-DD.html`

**B. An open chat with a few messages** (for `extractChat`):
1. Open any chat with at least 3-5 messages, including both incoming and outgoing
2. In DevTools, find the wrapping `<main>` / `<div>` of the message thread
3. Copy outerHTML, save to `tests/fixtures/<platform>-thread_YYYY-MM-DD.html`

Wrap the captured HTML in a minimal page so jsdom can parse it:

```html
<!--
  <Platform> fixture (captured YYYY-MM-DD).
  Re-capture and bump the date when the platform changes its DOM.
-->
<html><body>
<!-- pasted outerHTML here -->
</body></html>
```

**Date-stamp the filename.** Stale fixtures are worse than missing ones — they make tests pass against DOM that no longer exists in production.

### Step 2 — Register the platform

Edit [selectors.js](selectors.js):

```javascript
const PLATFORMS = {
  // ...existing platforms...
  myplatform: {
    id: 'myplatform',
    label: 'My Platform',
    hostPatterns: ['app.myplatform.com'],
    messagingPath: '/chat/',     // path prefix that identifies the messaging route
    csvPlatformName: 'MyPlatform', // value used in CSV's `Platform` column
  },
};
```

Then add a selector block under `PLATFORM_SELECTORS`:

```javascript
const PLATFORM_SELECTORS = {
  // ...
  myplatform: {
    conversationList:        { primary: '...', fallback: '...' },
    conversationItem:        { primary: '...', fallback: '...' },
    conversationItemName:    { primary: '...', fallback: '...' },
    conversationItemPreview: { primary: '...', fallback: '...' },
    conversationItemTime:    { primary: '...', fallback: '...' },
    conversationItemLink:    { primary: '...', fallback: '...' }, // can be the item itself if no <a>
    messageList:             { primary: '...', fallback: '...' },
    messageItem:             { primary: '...', fallback: '...' },
    messageSenderName:       { primary: '...', fallback: '...' },
    messageBody:             { primary: '...', fallback: '...' },
    messageTimestamp:        { primary: '...', fallback: '...' },
    messageGroup:            { primary: '...', fallback: '...' }, // wrapper if messages from same sender are grouped
    messageGroupMeta:        { primary: '...', fallback: '...' },
    messageScrollContainer:  { primary: '...', fallback: '...' },
  },
};
```

**Selector strategy:**
- `primary` — semantic / `aria-*` / `role` / `data-*` attributes. These survive UI redesigns longer than CSS classes.
- `fallback` — structural / class-based. Fragile but specific.
- The extraction code tries `primary` first; if it returns 0 elements, falls back.
- **Scope to a parent if possible.** WhatsApp's chat list lives in `#pane-side`; without that prefix `[role="row"]` matches both chat-list rows AND message rows in the open chat — exactly the bug that produced the "68 vs 69" inconsistency early in this project.

### Step 3 — Wire up the manifest

Edit [manifest.json](manifest.json):

```json
"host_permissions": [
  "*://*.myplatform.com/*"
],
"content_scripts": [
  {
    "matches": ["*://app.myplatform.com/chat/*"],
    "js": ["utils/logger.js", "utils/extractor.js", "selectors.js", "content_script.js"],
    "run_at": "document_idle"
  }
]
```

Reload the extension in `chrome://extensions/`.

### Step 4 — (Optional) Custom message extractor

For most platforms the generic strategies in `collectMessages()` work — they iterate `messageGroup` (or `messageItem` as a fallback) and pull `messageSenderName` / `messageBody` / `messageTimestamp` from each.

If your platform has unusual DOM (e.g., metadata embedded in an attribute like WhatsApp's `data-pre-plain-text`), add a platform-specific path at the top of `collectMessages()` in [content_script.js](content_script.js):

```javascript
function collectMessages(senderName, contactName, chatKey) {
  if (platformId === 'myplatform') {
    return collectMessagesMyPlatform(senderName, contactName, chatKey);
  }
  // ...generic fallbacks...
}

function collectMessagesMyPlatform(senderName, contactName, chatKey) {
  const messages = [];
  const messageEls = document.querySelectorAll('your-message-selector');
  for (const el of messageEls) {
    const isMine = /* your detection */;
    const text = cleanText(el.querySelector('body-selector')?.textContent);
    if (!text) continue;
    messages.push({
      platform: platform.csvPlatformName,
      messageDateRaw: /* your timestamp parse */,
      sender:   isMine ? senderName  : /* extracted name */,
      receiver: isMine ? contactName : senderName,
      text,
      chatKey,
    });
  }
  return messages;
}
```

The convention `sender / receiver / text / messageDateRaw / chatKey` is required — the CSV builder and date filter depend on these field names.

### Step 5 — Tests pick up your fixture automatically

Open [tests/unit/selector-health.test.js](tests/unit/selector-health.test.js) and add your platform to the `platforms` array:

```javascript
const platforms = [
  { id: 'whatsapp',         file: 'whatsapp-pane-side_2026-04-28.html' },
  { id: 'sales_navigator',  file: 'sales-navigator-list_2026-04-28.html' },
  { id: 'linkedin',         file: 'linkedin-list_2026-04-28.html' },
  { id: 'myplatform',       file: 'myplatform-list_YYYY-MM-DD.html' },  // <-- new
];
```

Run `npm test`. Every selector in your block must match ≥1 element in the fixture or the test fails with a diagnostic error pointing at the offending key.

### Step 6 — Smoke-test in the browser

1. Open `app.myplatform.com/chat/`
2. Open the side panel → click **Scan inbox** → expect `N chats found`
3. Pick 1-2 chats → set mode to **Test run** → **Process Selected Chats**
4. Expect ~3 messages per chat extracted, format correct
5. Click **Download log .txt** — share it on the PR if anything looks off

Done. Open a PR.

---

## Updating selectors

When a platform ships a DOM change and your `Scan` returns 0 chats, or extraction returns 0 messages:

1. **Run diagnostics first.** In the side panel, when extraction returns 0 messages it auto-runs `runDiagnostics()` and prints selector match counts. That report tells you which selector now returns 0.
2. **Open DevTools** on the messaging page, find the new attribute / class for the broken selector.
3. **Re-capture the fixture** — `copy(document.querySelector('#main').outerHTML)` and save to `tests/fixtures/<platform>-thread_<today>.html`. Delete the old fixture file (its date in the name should make this obvious).
4. **Update [selectors.js](selectors.js)** for that platform — usually just the `primary` line that broke.
5. **Run `npm test`** — selector-health test should pass with the new fixture.
6. **Smoke-test in the browser**.
7. PR.

If WhatsApp drops `.selectable-text` again (they do this every 18 months), do not panic. Update `messageBody`, re-run the test, ship.

---

## Other contributions

### New export formats

Currently CSV / TSV. PRs welcome for:

- **JSONL** — one message per line, drop-in for LLM fine-tuning pipelines (OpenAI, Anthropic, local Llama)
- **Markdown** — one chat per file, headed by contact + date — pleasant to grep and to read
- **SQLite** — for power users who want to query

The export pipeline lives in [utils/csv.js](utils/csv.js); add a sibling `utils/jsonl.js` (etc.) and wire it into [service_worker.js](service_worker.js)'s `exportToFile()`.

### Translations

The UI is short — about 20 strings. Today they're inline in [sidepanel.html](sidepanel.html). A first PR could extract them to a single `i18n.json` and add `chrome.i18n.getMessage()` lookups. Then translations can be added language by language.

### Bug reports

Use **Download log .txt** in the side panel and attach the file to the issue. The log contains only `chatKey` ids and selector counts — no message text, no contact names. Safe to share.

If you're filing a "platform broke" issue, include:
- Platform + URL
- Browser version (`chrome://version`)
- The diagnose output (auto-shown when extraction returns 0)
- Last few lines of the log around the failure

---

## Submitting a PR

- **One platform per PR.** A "Slack + Discord + Signal" PR is hard to review. Three PRs is easy.
- **Run tests locally.** `npm test` must pass — selector-health is the gate.
- **No `console.log` left in.** Use the structured logger (`Logger.logFor('cs').info('action.name', { key: val })`).
- **No PII in logs.** Pass `chatKey` (slug or URL-derived id), never `displayName`.
- **No new dependencies** unless you really need them. The whole runtime is currently dep-free; we'd like to keep it that way.
- **Update the supported-platforms table** in [README.md](README.md) when you add a platform.
- **Branch from `main`**, push, open the PR. Conventional commit-style messages preferred but not enforced.

For larger changes (new export pipeline, refactoring the state machine), please open an issue first to discuss the design.

---

## Code of conduct

Be kind. This is a side project people contribute to in their spare time. No bikeshedding about tabs vs spaces — there's already a convention in the codebase, follow it.

Reporting harassment or other concerns: `kondratevakate@gmail.com`.
