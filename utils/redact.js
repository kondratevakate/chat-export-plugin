/**
 * redact.js — PII pattern redaction for message text.
 *
 * Replaces emails, phone numbers, and URLs with placeholder tokens.
 */

const PII_PATTERNS = [
  {
    name: 'email',
    regex: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,
    replacement: '[EMAIL]',
  },
  {
    name: 'phone',
    // Matches common phone formats: +1-234-567-8901, (234) 567-8901, 234.567.8901, etc.
    regex: /(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}/g,
    replacement: '[PHONE]',
  },
  {
    name: 'url',
    regex: /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi,
    replacement: '[URL]',
  },
];

/**
 * Redact PII patterns from text.
 * @param {string} text
 * @param {string[]} patternsToRedact - Which patterns to apply: ['email','phone','url'] or subset
 * @returns {string} Redacted text
 */
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

if (typeof globalThis !== 'undefined') {
  globalThis.Redact = { redactPII, PII_PATTERNS };
}
