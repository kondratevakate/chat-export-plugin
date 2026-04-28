/**
 * mv3-guard.test.js — Static audit that the service worker doesn't use any
 * DOM-only API. Catches the URL.createObjectURL / Blob / document footgun
 * before it reaches a user.
 *
 * Why static: Manifest V3 service workers run without a DOM. APIs like
 * URL.createObjectURL throw "is not a function" at runtime. The repo doesn't
 * have a TypeScript type-check, so this grep-style test is the cheapest
 * guard. Add new forbidden patterns here when you find one in the wild.
 */

import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');

const FORBIDDEN_IN_SW = [
  // pattern,                                why,                                                                                  exemption (substring of the line that grants a pass)
  { pattern: /URL\.createObjectURL/,         why: 'Not implemented in MV3 service workers — produces "is not a function" at run time.' },
  { pattern: /\bdocument\./,                 why: 'No DOM in MV3 service workers.' },
  { pattern: /\bwindow\./,                   why: 'No window object in MV3 service workers.' },
  { pattern: /\blocalStorage\b/,             why: 'localStorage is unavailable; use chrome.storage.local instead.' },
  { pattern: /\bsessionStorage\b/,           why: 'sessionStorage is unavailable; use chrome.storage.session instead.' },
  // new Blob() works in service workers but is often paired with URL.createObjectURL,
  // so we flag it to force a manual review. Comment the line `// blob-ok:` to allow.
  { pattern: /new Blob\(/,                   why: 'Blobs without a serving channel rarely work in MV3 SW. If this is intentional, mark the line with "// blob-ok:".', exempt: 'blob-ok:' },
];

function readSW() {
  return readFileSync(resolve(repoRoot, 'service_worker.js'), 'utf8');
}

describe('service_worker.js — no DOM-only APIs', () => {
  const source = readSW();
  const lines = source.split('\n');

  for (const rule of FORBIDDEN_IN_SW) {
    test(`disallowed: ${rule.pattern}`, () => {
      const offenders = [];
      lines.forEach((line, idx) => {
        // Skip comment-only lines — they're allowed to mention the pattern,
        // including in the cautionary note that documents the rule.
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
        if (rule.pattern.test(line)) {
          if (rule.exempt && line.includes(rule.exempt)) return;
          offenders.push({ line: idx + 1, text: line.trim() });
        }
      });
      if (offenders.length) {
        const detail = offenders.map((o) => `  service_worker.js:${o.line}  ${o.text}`).join('\n');
        throw new Error(
          `Forbidden API used in service worker.\n  Why: ${rule.why}\n${detail}`
        );
      }
      expect(offenders).toEqual([]);
    });
  }
});

describe('cross-context log merging contract', () => {
  test('SW responses to CS may carry _cs_logs that get merged', () => {
    // Documentation test — pins the contract. content_script.js attaches
    // `_cs_logs` to every response; service_worker.js must merge them via
    // mergeCsLogsIntoBuffer in forwardToContentScript.
    const sw = readSW();
    expect(sw).toMatch(/mergeCsLogsIntoBuffer/);
    expect(sw).toMatch(/_cs_logs/);
  });

  test('downloadLog handler returns text + filename, never calls chrome.downloads in SW', () => {
    const sw = readSW();
    // The handler must return a payload the side panel can act on.
    expect(sw).toMatch(/case 'downloadLog':/);
    expect(sw).toMatch(/buildMergedLogText/);
    // It must NOT call chrome.downloads.download itself — the side panel does.
    const downloadHandler = sw.match(/case 'downloadLog':[\s\S]{0,400}/)?.[0] || '';
    expect(downloadHandler).not.toMatch(/chrome\.downloads\.download/);
  });
});
