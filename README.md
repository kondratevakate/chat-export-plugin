# Chat Export

> **Get your messages out of someone else's app — into a CSV on your disk, without sending a byte to a server.**

A privacy-first Chrome extension that scrapes your own chats from messaging webapps and saves them locally as CSV. No backend. No telemetry. No "sign in to continue." Open the side panel, click Scan, click Process, click Download.

[![Tests](https://img.shields.io/badge/tests-79%20passing-brightgreen)](#tests) [![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![Chrome MV3](https://img.shields.io/badge/Chrome-MV3-yellow)](manifest.json) [![PRs welcome](https://img.shields.io/badge/PRs-welcome-orange)](CONTRIBUTING.md)

---

## Why

You have years of conversations — DMs with clients, threads with friends, support back-and-forth — locked inside whatever JavaScript SPA the platform happens to ship this quarter. You want them out:

- **Train a personal LLM on your own writing style.** Cold-start prompts get boring; few-shot from your real messages doesn't.
- **Leaving a platform** and want a real archive, not a 600-page PDF nobody can grep.
- **Reviewing what you actually wrote** to a client / patient / collaborator over the past year.
- **Research / journalism** — bulk text data with timestamps, sender, receiver.
- **Cold reading** your own communication patterns. Honestly clarifying.

The official "data export" buttons either don't exist (LinkedIn Sales Navigator, half of WhatsApp's UI), take 24 hours, or hand you a 50 MB JSON nobody can use. This plugin reads what's already in your browser DOM and turns it into a clean CSV in 30 seconds.

## What ships in CSV

| Column | Example |
|---|---|
| Platform | `Whatsapp`, `Linkedin`, `Linkedin Sales Navigator` |
| Message Date | `12:34, 5/4/2024` (raw — your local time, as shown in the UI) |
| Sender | `Effie Guo` or your configured name |
| Receiver | The other party (or `CONTACT_3F2A4B91` in anonymized mode) |
| Message Text | Up to 500 chars, RFC-4180-quoted |

## Install (Chrome / Brave / Arc / any Chromium)

The extension isn't on the Chrome Web Store yet — install as unpacked, takes 30 seconds:

1. **Clone the repo**
   ```bash
   git clone https://github.com/kondratevakate/chat-export-plugin
   cd chat-export-plugin
   ```
2. **Open** `chrome://extensions/` (or `brave://extensions`, etc.)
3. **Toggle Developer mode** (top-right)
4. **Click "Load unpacked"** → pick the `chat-export-plugin` folder
5. **Pin the extension** (puzzle icon → pin) — you'll click its icon to open the side panel

That's it. No npm install needed to use it; only needed if you want to run the test suite.

## Usage

Open any supported messaging tab (`web.whatsapp.com`, `linkedin.com/messaging`, `linkedin.com/sales/inbox`, ...), click the extension icon, follow the four steps:

1. **Scan inbox** — reads the chat list from the page (auto-scrolls to load all of it).
2. **Pick chats** — search by name, click to add. Or flip the toggle to "All except excluded" mode.
3. **Run extraction** — choose mode:
   - **Test run** = last 3 messages per chat (cold/dry run, ~30 sec for 50 chats — answers "does this work at all?")
   - **Full conversation** = everything in the date range
4. **Download CSV** — pick `Chats in CSV`, `Chats in CSV (anonymized)`, or `Chats in TSV` → Download.

Lost? Click **Copy log** or **Download log** in the progress panel — every step gets a timestamped line, no PII in the log.

## Supported platforms

| Platform | Scan | Extract | Notes |
|---|---|---|---|
| **WhatsApp Web** | ✅ | ✅ | Reads `data-pre-plain-text` for sender + timestamp |
| **LinkedIn Messaging** | ✅ | ✅ | Standard messaging UI |
| **LinkedIn Sales Navigator** | ✅ | ✅ | Distinct DOM — separate selector set |
| **Instagram DMs** | 🟡 | 🟡 | Selectors scaffolded, untested on current DOM |
| **Telegram Web** | 🟡 | 🟡 | Selectors scaffolded, untested |
| **Slack, Discord, Signal Web, …** | 🔜 | 🔜 | Want one of these? See [CONTRIBUTING.md](CONTRIBUTING.md) — adding a platform is ~50 lines |

✅ tested with real DOM • 🟡 selectors written, needs verification • 🔜 not started

## Privacy

This is non-negotiable and the reason the project exists:

- **No network calls.** Inspect `manifest.json` — there are no `host_permissions` for any external API. Only the messaging hosts (read-only DOM access).
- **No telemetry.** No analytics SDK, no crash reporter, no "anonymous usage stats."
- **Local storage only.** Extracted messages live in `chrome.storage.local`. Click `Clear All Data` in Advanced settings to wipe.
- **Anonymization is local.** HMAC-SHA256 with a salt generated on first run, stored in `chrome.storage.local`, never exported. Deterministic across runs (same name → same `CONTACT_XXXXXXXX`) but irreversible without the salt.
- **Logs contain only IDs**, never message text or contact names — designed for the case where you'd want to share a log with a contributor for debugging.

## Tests

```bash
npm install   # one-time, dev-only
npm test      # 79 tests across 10 files
```

What the suite covers:

- `extractor.test.js` — pure transforms (dedupe, mode selection, timestamp ordering)
- `logger.test.js` — log format, ring buffer, PII safety
- `selector-health.test.js` — every selector matches ≥1 element on captured DOM fixtures (canary for platform DOM changes)
- `cancel.test.js` — abort flag interrupts long loops within one polling tick
- `mv3-guard.test.js` — service worker contains no DOM-only APIs (catches `URL.createObjectURL`-style runtime bombs at CI)
- `whatsapp-extraction.test.js` — `data-pre-plain-text` parser produces correct sender/timestamp
- `open-chat-matching.test.js` — fuzzy chat-name matching for virtualised lists
- `storage-resilience.test.js` — log buffer caps; messages survive SW restart
- `process-flow.test.js` — integration: cancel mid-run emits no further `processing` events
- `test-mode-ordering.test.js` — "last N" semantics pinned

Fixtures (`tests/fixtures/<platform>_<date>.html`) are dated so stale ones fail loud rather than silently rotting.

## Contributing

This project lives or dies by people adding more platforms. **Adding a new messenger is ~5 files and ~50 lines of code.** Full walk-through: [CONTRIBUTING.md](CONTRIBUTING.md).

Short version:
1. Capture a DOM fixture (`copy(document.querySelector('#main').outerHTML)` in DevTools)
2. Add selectors to [selectors.js](selectors.js) under a new platform key
3. Wire up the platform in `manifest.json` content_scripts
4. (Optional but appreciated) Write a platform-specific extractor in `content_script.js` if the message DOM is unusual
5. Drop the fixture in `tests/fixtures/`, the selector-health test picks it up automatically
6. Send a PR

We also welcome:
- **Bug reports** with the `Download log .txt` file attached (no PII, safe to share)
- **Selector updates** when a platform ships a DOM change
- **New export formats** (JSONL for ML training, Markdown for journaling, …)
- **Translations** of the UI

## Roadmap

- [ ] Chrome Web Store listing
- [ ] Slack / Discord / Signal selectors
- [ ] JSONL export for direct LLM fine-tuning ingestion
- [ ] Per-chat dry-run preview before full extraction
- [ ] Firefox port (Manifest V3 there is mostly compatible)
- [ ] Tauri desktop wrapper for non-browser messengers (iMessage on macOS, Telegram Desktop, ...)

## Docs

- [SETUP.md](SETUP.md) — install / usage detail
- [DESIGN.md](DESIGN.md) — architecture, state machine, data model
- [MAINTENANCE.md](MAINTENANCE.md) — how to update selectors when a platform ships a DOM change
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to add a new messenger

## License

[MIT](LICENSE) — do whatever you want, just don't blame us if you accidentally export your therapist's messages and lose the laptop on a train.
