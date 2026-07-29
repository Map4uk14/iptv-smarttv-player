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
function checkEs5(label, code) {
  try {
    parse(code, { ecmaVersion: 5, sourceType: "script" });
    return true;
  } catch (error) {
    const at = typeof error.pos === "number" ? error.pos : 0;
    failures.push(
      `${label}: not parseable as ES5 — ${error.message}\n      near: ${JSON.stringify(
        code.slice(Math.max(0, at - 60), at + 60),
      )}`,
    );
    return false;
  }
}

for (const { name, body } of jsFiles) {
  checkEs5(name, body);
}

// The EPG worker is inlined as a *string literal* and handed to a Blob, so
// parsing the bundle says nothing about it — a string is a string whatever it
// contains. It shipped with a Babel helper carrying a template literal and
// failed on the TV as `[epg] worker error: Unexpected token =` while every
// check here stayed green. Pull it back out of the AST and parse it too.
const WORKER_MARKER = "could not inflate the EPG";
let workerChecked = false;
for (const { body } of jsFiles) {
  let ast;
  try {
    ast = parse(body, { ecmaVersion: 2020, sourceType: "script" });
  } catch {
    continue; // already reported as not-ES5 above
  }
  const stack = [ast];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (node.type === "Literal" && typeof node.value === "string" && node.value.includes(WORKER_MARKER)) {
      workerChecked = checkEs5("inlined epg worker", node.value) || workerChecked;
      stack.length = 0;
      break;
    }
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (Array.isArray(value)) stack.push(...value);
      else if (value && typeof value.type === "string") stack.push(value);
    }
  }
}
if (!workerChecked) {
  failures.push(
    "could not find the inlined EPG worker to check it — if the worker was " +
      "removed or renamed, update WORKER_MARKER; silently skipping it is how " +
      "it shipped broken last time",
  );
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
// actually found here, with the Chromium version that introduced it. If layout
// breaks on the TV and this check is silent, suspect the list first.
//
// It scans the *built* bundle, not src/ui/styles.css. An earlier version read
// the source and passed a build that shipped the opposite: esbuild's CSS
// minifier assumes a modern browser and rewrote the four longhand offsets back
// into `inset: 0`, so the stylesheet was correct at source and broken on the
// TV. (`build.cssTarget` now stops that at the cause; this stops it shipping.)
// Scanning the output also covers CSS written from JavaScript — the <video>
// element's inline style, which no stylesheet check would ever see.
const LEGACY_CSS = [
  [/[;{"]inset:/, "inset (Chromium 87) — use top/right/bottom/left"],
  [/[;{"](row-|column-)?gap:/, "gap in flex (Chromium 84) — use margins"],
  [/#[0-9a-fA-F]{8}\b/, "8-digit #RRGGBBAA hex (Chromium 62) — use rgba()"],
  [/display:\s*grid/, "CSS grid (Chromium 57)"],
  [/position:\s*sticky/, "position: sticky (Chromium 56)"],
  [/var\(--/, "custom properties (Chromium 49)"],
  [/aspect-ratio:/, "aspect-ratio (Chromium 88)"],
  [/[;{"](clamp|min|max)\(/, "clamp()/min()/max() (Chromium 79)"],
];
for (const { name, body } of jsFiles) {
  for (const [pattern, label] of LEGACY_CSS) {
    const hit = pattern.exec(body);
    if (hit) {
      failures.push(
        `${name}: ${label}\n      near: ${JSON.stringify(
          body.slice(Math.max(0, hit.index - 50), hit.index + 50),
        )}`,
      );
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
