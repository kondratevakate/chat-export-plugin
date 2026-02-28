/**
 * test_anonymize.js — Unit tests for anonymization utilities.
 *
 * Run with: node tests/test_anonymize.js
 *
 * Uses Node.js built-in crypto to simulate the Web Crypto API behavior.
 */

const crypto = require('crypto');

// ── Polyfill the functions we're testing ──

function generateSalt() {
  return crypto.randomBytes(32).toString('hex');
}

async function anonymizeContact(displayName, saltHex) {
  const hmac = crypto.createHmac('sha256', saltHex);
  hmac.update(displayName.trim().toLowerCase());
  const hash = hmac.digest('hex');
  return 'CONTACT_' + hash.substring(0, 8).toUpperCase();
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

async function assertEqual(actual, expected, message) {
  if (actual === expected) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.error(`  FAIL: ${message} — expected "${expected}", got "${actual}"`);
  }
}

// ── Tests ──

async function runTests() {
  console.log('=== Anonymization Tests ===\n');

  // Test 1: Salt generation
  console.log('-- Salt Generation --');
  const salt1 = generateSalt();
  const salt2 = generateSalt();
  assert(salt1.length === 64, 'Salt is 64 hex characters');
  assert(salt1 !== salt2, 'Two salts are different');
  assert(/^[0-9a-f]+$/.test(salt1), 'Salt is valid hex');

  // Test 2: Deterministic anonymization
  console.log('\n-- Deterministic Anonymization --');
  const testSalt = 'a'.repeat(64);
  const anon1 = await anonymizeContact('Alice Smith', testSalt);
  const anon2 = await anonymizeContact('Alice Smith', testSalt);
  await assertEqual(anon1, anon2, 'Same name + salt = same anonymous ID');
  assert(anon1.startsWith('CONTACT_'), 'Anonymous ID starts with CONTACT_');
  assert(anon1.length === 16, 'Anonymous ID is CONTACT_ + 8 hex chars');

  // Test 3: Different names produce different IDs
  console.log('\n-- Different Names --');
  const anonAlice = await anonymizeContact('Alice Smith', testSalt);
  const anonBob = await anonymizeContact('Bob Jones', testSalt);
  assert(anonAlice !== anonBob, 'Different names produce different IDs');

  // Test 4: Case insensitivity
  console.log('\n-- Case Insensitivity --');
  const anonLower = await anonymizeContact('alice smith', testSalt);
  const anonUpper = await anonymizeContact('ALICE SMITH', testSalt);
  const anonMixed = await anonymizeContact('Alice Smith', testSalt);
  await assertEqual(anonLower, anonUpper, 'Case insensitive: lower == upper');
  await assertEqual(anonLower, anonMixed, 'Case insensitive: lower == mixed');

  // Test 5: Whitespace trimming
  console.log('\n-- Whitespace Trimming --');
  const anonTrimmed = await anonymizeContact('  Alice Smith  ', testSalt);
  const anonNormal = await anonymizeContact('Alice Smith', testSalt);
  await assertEqual(anonTrimmed, anonNormal, 'Leading/trailing whitespace is trimmed');

  // Test 6: Different salts produce different IDs
  console.log('\n-- Different Salts --');
  const saltA = 'a'.repeat(64);
  const saltB = 'b'.repeat(64);
  const anonSaltA = await anonymizeContact('Alice Smith', saltA);
  const anonSaltB = await anonymizeContact('Alice Smith', saltB);
  assert(anonSaltA !== anonSaltB, 'Different salts produce different IDs');

  // Summary
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
