# Chat Export Plugin

Privacy-first Chrome Extension to export messaging chats to CSV.

## Supported Platforms

- **LinkedIn** (fully implemented)
- **Instagram** (selectors scaffolded — needs testing)
- **WhatsApp Web** (selectors scaffolded — needs testing)
- **Telegram Web** (selectors scaffolded — needs testing)

## Features

- Export messages to CSV with columns: Platform, Message Date, Sender, Receiver, Message Text
- Select specific chats or process all except excluded
- Date range filtering
- Anonymize contacts (HMAC-SHA256 with local salt)
- Redact PII (emails, phones, URLs)
- One-row-per-message or one-row-per-conversation mode
- All data stays local — no network calls, no cloud storage

## Quick Start

1. Clone this repo
2. Open `chrome://extensions/` → Enable Developer Mode → Load Unpacked → select this folder
3. Navigate to `linkedin.com/messaging/`
4. Click the extension icon to open the side panel
5. Scan → Select → Process → Download

See [SETUP.md](SETUP.md) for detailed instructions.

## Docs

- [DESIGN.md](DESIGN.md) — Architecture, state machine, data model
- [SETUP.md](SETUP.md) — Installation and usage guide
- [MAINTENANCE.md](MAINTENANCE.md) — How to update selectors when UIs change

## Tests

```bash
node tests/test_anonymize.js
node tests/test_csv.js
```
