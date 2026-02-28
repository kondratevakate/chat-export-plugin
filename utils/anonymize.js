/**
 * anonymize.js — HMAC-SHA256 based contact anonymization.
 *
 * Generates deterministic anonymous IDs from display names using a local salt.
 * Salt is stored in chrome.storage.local and never exported.
 */

/**
 * Generate a cryptographically random salt (hex string).
 * @returns {string} 64-char hex salt
 */
function generateSalt() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Derive an anonymous ID from a display name using HMAC-SHA256.
 * @param {string} displayName - The contact's display name
 * @param {string} saltHex - Hex-encoded salt
 * @returns {Promise<string>} Anonymous ID like "CONTACT_A1B2C3D4"
 */
async function anonymizeContact(displayName, saltHex) {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(saltHex);
  const messageData = encoder.encode(displayName.trim().toLowerCase());

  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', key, messageData);
  const hashArray = Array.from(new Uint8Array(signature));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

  return 'CONTACT_' + hashHex.substring(0, 8).toUpperCase();
}

/**
 * Get or create the local anonymization salt.
 * @returns {Promise<string>} The salt hex string
 */
async function getOrCreateSalt() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['anonSalt'], (result) => {
      if (result.anonSalt) {
        resolve(result.anonSalt);
      } else {
        const salt = generateSalt();
        chrome.storage.local.set({ anonSalt: salt }, () => resolve(salt));
      }
    });
  });
}

// Export for module and non-module contexts
if (typeof globalThis !== 'undefined') {
  globalThis.Anonymize = { generateSalt, anonymizeContact, getOrCreateSalt };
}
