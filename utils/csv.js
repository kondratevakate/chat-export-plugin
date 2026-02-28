/**
 * csv.js — RFC 4180 compliant CSV builder for chat export.
 *
 * Columns (strict order): Platform | Message Date | Sender | Receiver | Message Text
 */

const CSV_COLUMNS = ['Platform', 'Message Date', 'Sender', 'Receiver', 'Message Text'];
const MAX_TEXT_LENGTH = 500;
const UTF8_BOM = '\uFEFF';

/**
 * Escape a CSV field per RFC 4180.
 * @param {string} value
 * @returns {string}
 */
function escapeCSVField(value) {
  const str = String(value ?? '');
  if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

/**
 * Truncate text to maxLength, adding ellipsis if truncated.
 * @param {string} text
 * @param {number} maxLength
 * @returns {string}
 */
function truncateText(text, maxLength = MAX_TEXT_LENGTH) {
  if (!text) return '';
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return trimmed.substring(0, maxLength - 3) + '...';
}

/**
 * Build a CSV row from an ExtractedMessage object.
 * @param {object} msg - { platform, messageDateRaw, sender, receiver, text }
 * @returns {string} CSV row
 */
function buildCSVRow(msg) {
  const fields = [
    escapeCSVField(msg.platform || 'Linkedin'),
    escapeCSVField(msg.messageDateRaw || ''),
    escapeCSVField(msg.sender || ''),
    escapeCSVField(msg.receiver || ''),
    escapeCSVField(truncateText(msg.text)),
  ];
  return fields.join(',');
}

/**
 * Build a complete CSV string from an array of ExtractedMessage objects.
 * @param {object[]} messages
 * @returns {string} Full CSV with BOM header
 */
function buildCSV(messages) {
  const header = CSV_COLUMNS.map(escapeCSVField).join(',');
  const rows = messages.map(buildCSVRow);
  return UTF8_BOM + header + '\n' + rows.join('\n');
}

/**
 * Build a TSV string from an array of ExtractedMessage objects.
 * @param {object[]} messages
 * @returns {string}
 */
function buildTSV(messages) {
  const escapeTSV = (val) => String(val ?? '').replace(/[\t\n\r]/g, ' ');
  const header = CSV_COLUMNS.map(escapeTSV).join('\t');
  const rows = messages.map(msg => [
    escapeTSV(msg.platform || 'Linkedin'),
    escapeTSV(msg.messageDateRaw || ''),
    escapeTSV(msg.sender || ''),
    escapeTSV(msg.receiver || ''),
    escapeTSV(truncateText(msg.text)),
  ].join('\t'));
  return header + '\n' + rows.join('\n');
}

/**
 * Merge messages into one-row-per-conversation format.
 * @param {object[]} messages - Array of ExtractedMessage
 * @returns {object[]} One entry per chatKey with combined text
 */
function mergeByConversation(messages) {
  const grouped = new Map();
  for (const msg of messages) {
    if (!grouped.has(msg.chatKey)) {
      grouped.set(msg.chatKey, {
        platform: msg.platform,
        messageDateRaw: msg.messageDateRaw,
        sender: msg.sender,
        receiver: msg.receiver,
        text: msg.text,
        chatKey: msg.chatKey,
        _texts: [msg.text],
      });
    } else {
      const entry = grouped.get(msg.chatKey);
      entry._texts.push(msg.text);
      entry.messageDateRaw += '; ' + msg.messageDateRaw;
    }
  }
  for (const [, entry] of grouped) {
    entry.text = truncateText(entry._texts.join(' | '), MAX_TEXT_LENGTH);
    delete entry._texts;
  }
  return Array.from(grouped.values());
}

if (typeof globalThis !== 'undefined') {
  globalThis.CSVBuilder = {
    CSV_COLUMNS,
    MAX_TEXT_LENGTH,
    escapeCSVField,
    truncateText,
    buildCSVRow,
    buildCSV,
    buildTSV,
    mergeByConversation,
  };
}
