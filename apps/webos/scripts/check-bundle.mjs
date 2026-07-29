/**
 * Guard the production bundle against things that would break or slow the TV.
 *
 * Every check here corresponds to a claim made in ARCHITECTURE.md. Asserting
 * them in CI is the difference between a design decision and a hopeful comment.
 *
 * 1. hls.js must NOT ship. It exists only so the app is testable in a desktop
 *    browser. On webOS it would mean software demux instead of the hardware
 *    pipeline.
 * 2. No syntax newer than ES2017. webOS 4.x runs Chromium 53, where optional
 *    chaining is a *parse* error — the whole bundle fails to load, so this
 *    fails as a blank screen rather than a degraded feature.
 * 3. Asset paths must be relative. Packaged apps load from file://, where an
 *    absolute /assets/... path silently 404s.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const failures = [];

if (!existsSync(DIST)) {
  console.error("dist/ not found — run the build first.");
  process.exit(1);
}

const jsFiles = readdirSync(join(DIST, "assets"))
  .filter((f) => f.endsWith(".js"))
  .map((f) => ({ name: f, body: readFileSync(join(DIST, "assets", f), "utf8") }));

// --- 1. hls.js must be absent -------------------------------------------
//
// These fingerprints were calibrated against a known-good and a known-bad
// input rather than guessed: each appears in node_modules/hls.js/dist/hls.min.js
// and in neither our bundle nor the stub. An earlier version of this check used
// `MANIFEST_PARSED` and `isSupported`, which also occur at our own call site and
// in the stub — it reported a false positive on a clean bundle. If you add a
// fingerprint here, verify it the same way before trusting a red result.
const HLS_FINGERPRINTS = [/bufferAppendError/, /levelSwitchError/, /manifestLoadingTimeOut/];
for (const { name, body } of jsFiles) {
  const hit = HLS_FINGERPRINTS.find((p) => p.test(body));
  if (hit) {
    failures.push(`${name}: real hls.js appears to be bundled (matched ${hit}) — it must be dev-only`);
  }
}
// A chunk *named* hls is expected and fine — production aliases hls.js to an
// inert stub, so the name survives while the library does not. What matters is
// size: the real library is ~500 kB, the stub is a few hundred bytes.
for (const { name, body } of jsFiles) {
  if (/hls/i.test(name) && body.length > 8 * 1024) {
    failures.push(`${name}: ${(body.length / 1024).toFixed(0)} kB is too large to be the hls stub`);
  }
}

// --- 2. ES2017 ceiling ---------------------------------------------------
//
// The bundle now carries the stylesheet inlined as a string (the TV loads from
// file://, where a <link> to a sibling .css is blocked by CORS), so these
// patterns see CSS as well as JS. The private-field check has to tell `#a1b2c3;`
// in a declaration from a real `#field =`; see IGNORE below.
const HEX_COLOUR = /^[0-9a-fA-F]{3,4}$|^[0-9a-fA-F]{6}$|^[0-9a-fA-F]{8}$/;

const MODERN_SYNTAX = [
  [/\?\./g, "optional chaining (?.)"],
  [/\?\?/g, "nullish coalescing (??)"],
  [
    /(^|[^\w$])#([A-Za-z_$][\w$]*)\s*[=(;]/g,
    "private class fields (#x)",
    // A CSS colour is only ever 3, 4, 6 or 8 hex digits. A private field named
    // exactly like one (#abc, #deadbeef) would slip through; that is a better
    // trade than failing every build because the stylesheet mentions #b9c0cc.
    (m) => HEX_COLOUR.test(m[2]),
  ],
  [/\bBigInt\b|\d+n\b/g, "BigInt literals"],
  [/\bcatch\s*\{/g, "optional catch binding"],
  [/\*\*=/g, "exponentiation assignment"],
];
for (const { name, body } of jsFiles) {
  for (const [pattern, label, ignore] of MODERN_SYNTAX) {
    const hit = [...body.matchAll(pattern)].find((m) => !(ignore && ignore(m)));
    if (hit) {
      failures.push(
        `${name}: contains ${label} — not parseable on Chromium 53 (near: ${JSON.stringify(
          body.slice(Math.max(0, hit.index - 40), hit.index + 40),
        )})`,
      );
    }
  }
}

// --- 3. relative asset paths --------------------------------------------
const html = readFileSync(join(DIST, "index.html"), "utf8");
for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const url = match[1];
  if (url.startsWith("/")) {
    failures.push(`index.html: absolute asset path "${url}" — breaks under file://`);
  }
}

// --- 4. required launcher files -----------------------------------------
for (const required of ["appinfo.json", "icon.png", "largeIcon.png", "index.html"]) {
  if (!existsSync(join(DIST, required))) failures.push(`missing required file: ${required}`);
}

if (failures.length > 0) {
  console.error("\nBundle checks FAILED:\n");
  for (const f of failures) console.error("  ✗ " + f);
  console.error("");
  process.exit(1);
}

const totalKb = (jsFiles.reduce((n, f) => n + f.body.length, 0) / 1024).toFixed(1);
console.log(`Bundle checks passed (${jsFiles.length} js file(s), ${totalKb} kB): no hls.js, ES2017-safe, relative paths.`);
