/**
 * Guard the production bundle against things that would break or slow the TV.
 *
 * Every check here corresponds to a claim made in ARCHITECTURE.md. Asserting
 * them in CI is the difference between a design decision and a hopeful comment.
 *
 * 1. hls.js must NOT ship. It exists only so the app is testable in a desktop
 *    browser. On webOS it would mean software demux instead of the hardware
 *    pipeline.
 * 2. The bundle must parse as ES5. The reference TV's engine predates Chromium
 *    45 and rejects arrow functions, and a parse error kills the entire script
 *    — it fails as a blank screen, not a degraded feature.
 * 3. Asset paths must be relative. Packaged apps load from file://, where an
 *    absolute /assets/... path silently 404s.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse } from "acorn";

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

// --- 2. ES5 ceiling ------------------------------------------------------
//
// Parse the bundle as ES5 instead of pattern-matching for known-bad syntax.
//
// This check used to be a list of regexes for ES2018+ features, and it passed
// a bundle the TV could not read: the engine turned out to predate Chromium 45
// and died on `SyntaxError: Unexpected token =>`. Arrow functions were never on
// the list, because the list was written against the wrong ceiling. An
// allowlist of forbidden features can only catch what its author already
// suspected — a parser catches everything, and cannot drift from the target.
//
// A parse failure here is not cosmetic. The engine rejects the whole script
// before any of it runs, so it surfaces on the TV as a black screen with no
// on-screen error at all.
for (const { name, body } of jsFiles) {
  try {
    parse(body, { ecmaVersion: 5, sourceType: "script" });
  } catch (error) {
    const at = typeof error.pos === "number" ? error.pos : 0;
    failures.push(
      `${name}: not parseable as ES5 — ${error.message}\n      near: ${JSON.stringify(
        body.slice(Math.max(0, at - 60), at + 60),
      )}`,
    );
  }
}

// --- 3. CSS the TV's engine would drop ----------------------------------
//
// Unsupported CSS fails quietly — the declaration is skipped and layout is
// merely wrong, so nothing in the build or the console says a word. `inset: 0`
// cost an evening: the video element's container collapsed to 0x0 and the
// channel played with perfect sound and no picture.
//
// Unlike the ES5 check above, this is a blocklist and carries that weakness
// honestly: it only catches what is listed. Each entry is here because it was
// actually found in this stylesheet, with the Chromium version that introduced
// it. If layout breaks on the TV and this check is silent, suspect the list
// before suspecting the CSS.
const CSS_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "ui", "styles.css");
const LEGACY_CSS = [
  [/^\s*inset:/m, "inset (Chromium 87) — use top/right/bottom/left"],
  [/^\s*(row-|column-)?gap:/m, "gap in flex (Chromium 84) — use margins"],
  [/#[0-9a-fA-F]{8}\b/, "8-digit #RRGGBBAA hex (Chromium 62) — use rgba()"],
  [/display:\s*grid/, "CSS grid (Chromium 57)"],
  [/position:\s*sticky/, "position: sticky (Chromium 56)"],
  [/var\(--/, "custom properties (Chromium 49)"],
  [/aspect-ratio:/, "aspect-ratio (Chromium 88)"],
  [/:\s*(clamp|min|max)\(/, "clamp()/min()/max() (Chromium 79)"],
];
if (existsSync(CSS_FILE)) {
  const css = readFileSync(CSS_FILE, "utf8");
  for (const [pattern, label] of LEGACY_CSS) {
    const hit = pattern.exec(css);
    if (hit) {
      const line = css.slice(0, hit.index).split("\n").length;
      failures.push(`styles.css:${line}: ${label}`);
    }
  }
}

// --- 4. relative asset paths --------------------------------------------
const html = readFileSync(join(DIST, "index.html"), "utf8");
for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const url = match[1];
  if (url.startsWith("/")) {
    failures.push(`index.html: absolute asset path "${url}" — breaks under file://`);
  }
}

// --- 5. required launcher files -----------------------------------------
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
console.log(`Bundle checks passed (${jsFiles.length} js file(s), ${totalKb} kB): no hls.js, parses as ES5, relative paths.`);
