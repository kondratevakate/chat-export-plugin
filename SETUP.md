# Chat Export — Setup & Usage Guide

## Installation (Load Unpacked)

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the `chat-export-plugin` folder
5. The extension icon will appear in your toolbar

## Usage

### 1. Navigate to Messaging

Open one of the supported platforms:
- **LinkedIn**: `linkedin.com/messaging/`
- **Instagram**: `instagram.com/direct/` *(planned)*
- **WhatsApp**: `web.whatsapp.com` *(planned)*
- **Telegram**: `web.telegram.org` *(planned)*

### 2. Open the Side Panel

Click the extension icon in the Chrome toolbar. The side panel will open.

### 3. Scan Inbox

Click **Scan Inbox** to read the visible conversation list. Scroll down in the messaging sidebar first if you want to include more conversations.

### 4. Select Chats

- Type a contact name in the search box
- Click suggestions to add them to the **Selected** list
- Remove chats by clicking the × on their chip

**Modes:**
- **Selected only** (default): Only process the chats you select
- **All except excluded**: Process all scanned chats except those in the Excluded list

### 5. Configure

- **Date range**: Filter messages by date (From / To)
- **Export format**: CSV, anonymized CSV, or TSV
- **Settings tab**: Change sender name, messages per chat (N), row mode, PII redaction

### 6. Process Queue

Click **Process Selected Chats**. The extension will:
1. Open each selected conversation
2. Wait for messages to render
3. Scroll up to load older messages (with safe limits)
4. Collect the first N messages authored by you
5. Show progress in the panel

### 7. Download

Click **Download** to save the CSV file.

## CSV Format

| Column       | Description                                  |
|-------------|----------------------------------------------|
| Platform    | "Linkedin", "Instagram", "Whatsapp", etc.   |
| Message Date| Timestamp as shown in the UI                 |
| Sender      | Who wrote the message                        |
| Receiver    | Who received (or anonymized CONTACT_XXXX)    |
| Message Text| Message content (max 500 chars)              |

## Tips

- **Scan often**: If you scroll the inbox to load more conversations, click Scan again
- **Process in batches**: Select 5-10 chats at a time for reliability
- **Check progress**: Failed chats show reasons (timeout, DOM not found, etc.)
- **Anonymized export**: Uses HMAC-SHA256 with a local salt — deterministic but irreversible
- **PII redaction**: Replaces emails, phone numbers, and URLs with `[EMAIL]`, `[PHONE]`, `[URL]`

## Troubleshooting

| Issue                          | Solution                                          |
|-------------------------------|---------------------------------------------------|
| "No LinkedIn Messaging tab"  | Open linkedin.com/messaging/ in a tab             |
| "Content script not responding"| Refresh the LinkedIn page, then try again         |
| "No conversations found"     | Scroll the inbox to load conversations, then scan |
| Few messages extracted        | LinkedIn loads limited history — try scrolling up manually first |
| Extension not appearing       | Check chrome://extensions — make sure it's enabled |
