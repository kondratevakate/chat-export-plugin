/**
 * load-script.js — Helper to load classic-script extension files into Node tests.
 *
 * The extension files are not ESM modules — they're classic <script> files
 * that attach to globalThis. To test them we read the source, evaluate it
 * in a fresh module-like scope, and return the captured globals.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');

/**
 * Load one of the extension's classic-script files in an isolated VM context.
 *
 * The extension files use one of two export styles:
 *   1. `module.exports = { X }` (utils/logger.js, utils/extractor.js)
 *   2. `globalThis.X = ...` (selectors.js)
 *
 * This helper merges both into a single returned object so test code does
 * not need to know which file uses which style.
 */
export function loadScriptCJS(relativePath) {
  const fullPath = resolve(repoRoot, relativePath);
  const source = readFileSync(fullPath, 'utf8');
  const fakeGlobal = {};
  const sandbox = {
    module: { exports: {} },
    exports: undefined,
    console,
    globalThis: fakeGlobal,
    setTimeout,
    clearTimeout,
  };
  sandbox.exports = sandbox.module.exports;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: relativePath });
  // Merge module.exports + anything written to globalThis so callers get
  // a single flat export shape.
  return { ...fakeGlobal, ...sandbox.module.exports };
}

/**
 * Load a classic-script file into a JSDOM window so it can use document/window
 * (selectors.js + content_script.js mode).
 */
export function loadScriptIntoDOM(window, relativePath) {
  const fullPath = resolve(repoRoot, relativePath);
  const source = readFileSync(fullPath, 'utf8');
  const script = new window.Function(source);
  script.call(window);
}

export { repoRoot };
