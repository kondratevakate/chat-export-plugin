/**
 * test_csv.js — Unit tests for CSV builder utilities.
 *
 * Run with: node tests/test_csv.js
 */

// ── Inline the functions we're testing (no browser globals needed) ──

const CSV_COLUMNS = ['Platform', 'Message Date', 'Sender', 'Receiver', 'Message Text'];
const MAX_TEXT_LENGTH = 500;
const UTF8_BOM = '\uFEFF';

function escapeCSVField(value) {
  const str = String(value ?? '');
  if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function truncateText(text, maxLength = MAX_TEXT_LENGTH) {
  if (!text) return '';
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return trimmed.substring(0, maxLength - 3) + '...';
}

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

function buildCSV(messages) {
  const header = CSV_COLUMNS.map(escapeCSVField).join(',');
  const rows = messages.map(buildCSVRow);
  return UTF8_BOM + header + '\n' + rows.join('\n');
}

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

// PII Redaction
const PII_PATTERNS = [
  { name: 'email', regex: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, replacement: '[EMAIL]' },
  { name: 'phone', regex: /(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}/g, replacement: '[PHONE]' },
  { name: 'url', regex: /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi, replacement: '[URL]' },
];

function redactPII(text, patternsToRedact = ['email', 'phone', 'url']) {
  if (!text) return '';
  let result = text;
  for (const pattern of PII_PATTERNS) {
    if (patternsToRedact.includes(pattern.name)) {
      result = result.replace(pattern.regex, pattern.replacement);
    }
  }
  return result;
}

// ── Test Runner ──

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  if (actual === expected) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
    console.error(`    Expected: ${JSON.stringify(expected)}`);
    console.error(`    Actual:   ${JSON.stringify(actual)}`);
  }
}

// ── Tests ──

function runTests() {
  console.log('=== CSV Builder Tests ===\n');

  // Test 1: escapeCSVField
  console.log('-- escapeCSVField --');
  assertEqual(escapeCSVField('hello'), 'hello', 'Plain string unchanged');
  assertEqual(escapeCSVField('hello,world'), '"hello,world"', 'Comma triggers quoting');
  assertEqual(escapeCSVField('say "hi"'), '"say ""hi"""', 'Quotes are doubled');
  assertEqual(escapeCSVField('line1\nline2'), '"line1\nline2"', 'Newline triggers quoting');
  assertEqual(escapeCSVField(''), '', 'Empty string');
  assertEqual(escapeCSVField(null), '', 'Null becomes empty');
  assertEqual(escapeCSVField(undefined), '', 'Undefined becomes empty');

  // Test 2: truncateText
  console.log('\n-- truncateText --');
  assertEqual(truncateText('short'), 'short', 'Short text unchanged');
  assertEqual(truncateText('  spaced  '), 'spaced', 'Whitespace trimmed');
  assertEqual(truncateText(''), '', 'Empty string');
  assertEqual(truncateText(null), '', 'Null returns empty');
  const longText = 'x'.repeat(600);
  const truncated = truncateText(longText);
  assert(truncated.length === 500, 'Truncated to 500 chars');
  assert(truncated.endsWith('...'), 'Ends with ellipsis');
  assertEqual(truncateText('x'.repeat(500)).length, 500, 'Exactly 500 chars not truncated');

  // Test 3: buildCSVRow
  console.log('\n-- buildCSVRow --');
  const row = buildCSVRow({
    platform: 'Linkedin',
    messageDateRaw: 'Dec 2, 2025',
    sender: 'Kate Kondrateva',
    receiver: 'Alice Smith',
    text: 'Hello there',
  });
  assertEqual(row, 'Linkedin,"Dec 2, 2025",Kate Kondrateva,Alice Smith,Hello there',
    'Simple row builds correctly (date with comma is quoted)');

  // Test row with commas in text
  const rowComma = buildCSVRow({
    platform: 'Linkedin',
    messageDateRaw: 'Dec 2, 2025',
    sender: 'Kate',
    receiver: 'Bob',
    text: 'Hello, how are you?',
  });
  assert(rowComma.includes('"Hello, how are you?"'), 'Text with comma is quoted');

  // Test 4: buildCSV
  console.log('\n-- buildCSV --');
  const csv = buildCSV([
    { platform: 'Linkedin', messageDateRaw: '2025-01-01', sender: 'Kate', receiver: 'Alice', text: 'Hi' },
    { platform: 'Linkedin', messageDateRaw: '2025-01-02', sender: 'Alice', receiver: 'Kate', text: 'Hello' },
  ]);
  assert(csv.startsWith(UTF8_BOM), 'CSV starts with BOM');
  assert(csv.includes('Platform,Message Date,Sender,Receiver,Message Text'), 'CSV has header');
  const lines = csv.split('\n');
  assertEqual(lines.length, 3, 'CSV has header + 2 data rows');

  // Test 5: mergeByConversation
  console.log('\n-- mergeByConversation --');
  const merged = mergeByConversation([
    { platform: 'Linkedin', messageDateRaw: '2025-01-01', sender: 'Kate', receiver: 'Alice', text: 'msg1', chatKey: 'chat1' },
    { platform: 'Linkedin', messageDateRaw: '2025-01-02', sender: 'Kate', receiver: 'Alice', text: 'msg2', chatKey: 'chat1' },
    { platform: 'Linkedin', messageDateRaw: '2025-01-03', sender: 'Kate', receiver: 'Bob', text: 'msg3', chatKey: 'chat2' },
  ]);
  assertEqual(merged.length, 2, 'Two conversations after merge');
  assert(merged[0].text.includes('msg1'), 'First conversation has msg1');
  assert(merged[0].text.includes('msg2'), 'First conversation has msg2');
  assertEqual(merged[1].text, 'msg3', 'Second conversation has msg3');

  // Test 6: PII Redaction
  console.log('\n-- PII Redaction --');
  assertEqual(
    redactPII('Email me at test@example.com'),
    'Email me at [EMAIL]',
    'Email redacted'
  );
  assertEqual(
    redactPII('Call +1-234-567-8901'),
    'Call [PHONE]',
    'Phone redacted'
  );
  assertEqual(
    redactPII('Visit https://example.com/page?q=1'),
    'Visit [URL]',
    'URL redacted'
  );
  assertEqual(
    redactPII('Email test@a.com, call 555-123-4567, see https://x.co'),
    'Email [EMAIL], call [PHONE], see [URL]',
    'Multiple PII types redacted'
  );
  assertEqual(
    redactPII('No PII here'),
    'No PII here',
    'No PII unchanged'
  );
  assertEqual(
    redactPII('test@a.com', ['email']),
    '[EMAIL]',
    'Selective redaction: email only'
  );
  assertEqual(
    redactPII('test@a.com', ['phone']),
    'test@a.com',
    'Selective redaction: phone only leaves email'
  );

  // Summary
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
