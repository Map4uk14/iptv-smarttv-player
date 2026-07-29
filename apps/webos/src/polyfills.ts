/**
 * Runtime polyfills for the TV's browser engine.
 *
 * The reference TV rejected the bundle outright with
 * `SyntaxError: Unexpected token =>` — arrow functions, so the engine predates
 * Chromium 45, not the Chromium 53 the build originally assumed. Its DevTools
 * still show the Timeline/Profiles/Resources tabs, dropped in Chrome 57.
 *
 * Syntax is handled by transpiling the bundle to ES5 (scripts/transpile-es5.mjs).
 * That leaves the library gaps, which is what this file covers:
 *
 *   fetch                  Chrome 42   — the playlist and EPG both need it
 *   Object.assign          Chrome 45   — emitted by the transpiler itself
 *   Array.prototype.find   Chrome 45
 *   Array.prototype.includes / String.prototype.includes   Chrome 47 / 41
 *   regeneratorRuntime     — async/await cannot lower to ES5 without it
 *
 * Imported first thing in main.tsx: the transpiled bundle references
 * `regeneratorRuntime` as a free variable, so it has to exist before any other
 * module body runs.
 *
 * `core-js/stable` is deliberately whole rather than cherry-picked. Getting the
 * list wrong fails as a blank screen on hardware I cannot test against, and the
 * difference is tens of kilobytes on a device that loads from local storage.
 */

import "core-js/stable";
import "regenerator-runtime/runtime";
import "whatwg-fetch";
