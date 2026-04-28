/**
 * manifest.test.js — Validates the MV3 manifest invariants.
 *
 * Regression for an incident on 2026-04-28: a merge silently introduced two
 * content_scripts entries with the same match pattern. Chrome rejected the
 * manifest at extension load time with "Service worker registration failed.
 * Status code: 15" — looks like a SW bug but is actually a manifest one.
 *
 * Cheap static checks, runs in milliseconds.
 */

import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');

const manifest = JSON.parse(readFileSync(resolve(repoRoot, 'manifest.json'), 'utf8'));

describe('manifest.json — Manifest V3 invariants', () => {
  test('manifest_version is 3', () => {
    expect(manifest.manifest_version).toBe(3);
  });

  test('service_worker is declared', () => {
    expect(manifest.background?.service_worker).toBeTruthy();
  });

  test('side_panel default_path is set', () => {
    expect(manifest.side_panel?.default_path).toBeTruthy();
  });

  test('every content_script match pattern is unique', () => {
    // Chrome rejects a manifest with two entries declaring the SAME
    // match pattern — surfaces as "Service worker registration failed,
    // Status code: 15" which looks like an SW bug but is a manifest one.
    const cs = manifest.content_scripts || [];
    const seen = new Map(); // pattern -> first index
    const duplicates = [];
    cs.forEach((entry, i) => {
      for (const pattern of entry.matches || []) {
        if (seen.has(pattern)) {
          duplicates.push({ pattern, firstIndex: seen.get(pattern), secondIndex: i });
        } else {
          seen.set(pattern, i);
        }
      }
    });
    if (duplicates.length) {
      const detail = duplicates
        .map((d) => `  pattern "${d.pattern}" appears in content_scripts[${d.firstIndex}] and [${d.secondIndex}]`)
        .join('\n');
      throw new Error(`Duplicate content_script match patterns:\n${detail}`);
    }
    expect(duplicates).toEqual([]);
  });

  test('every content_script lists the same loader files in the same order', () => {
    // Drift between content_script entries (e.g., one missing utils/logger.js)
    // is the second-most-common cause of "Logger is not defined" runtime errors.
    const cs = manifest.content_scripts || [];
    if (cs.length === 0) return;
    const expected = cs[0].js.slice();
    const drifted = [];
    cs.forEach((entry, i) => {
      const got = entry.js || [];
      if (got.length !== expected.length || got.some((f, j) => f !== expected[j])) {
        drifted.push({ index: i, pattern: entry.matches?.[0], got });
      }
    });
    if (drifted.length) {
      const detail = drifted
        .map((d) => `  content_scripts[${d.index}] (${d.pattern}) has [${d.got.join(', ')}]`)
        .join('\n');
      throw new Error(
        `Content scripts have inconsistent file lists.\n  Expected: [${expected.join(', ')}]\n${detail}`
      );
    }
  });

  test('all referenced files exist on disk', () => {
    const referenced = new Set();
    referenced.add(manifest.background?.service_worker);
    referenced.add(manifest.side_panel?.default_path);
    for (const cs of manifest.content_scripts || []) {
      for (const f of cs.js || []) referenced.add(f);
    }
    referenced.delete(undefined);

    const fs = readFileSync; // alias used to make missing files fail with a clear path
    const missing = [];
    for (const path of referenced) {
      try { fs(resolve(repoRoot, path), 'utf8'); }
      catch { missing.push(path); }
    }
    if (missing.length) {
      throw new Error(`Files referenced by manifest.json but not on disk:\n  ${missing.join('\n  ')}`);
    }
  });
});
