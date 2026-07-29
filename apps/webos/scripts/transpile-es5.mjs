/**
 * Lower the built bundle to ES5.
 *
 * The reference TV's engine is Chromium 38: it rejects the bundle with
 * `SyntaxError: Unexpected token =>` before a single line runs, which presents
 * as a black screen. Vite's `build.target` cannot solve this on its own —
 * esbuild refuses to lower async/await to ES5 ("Transforming async functions to
 * the configured target environment is not supported yet"), and this app is
 * async throughout. So esbuild takes it as far as it can and Babel finishes the
 * job here, on the emitted bundle.
 *
 * Running after the bundler rather than as a Vite plugin is deliberate: it
 * transforms exactly what ships, including whatever Vite's own runtime helpers
 * inject, and leaves the dev server untouched.
 *
 * The EPG worker is handled separately, in the Vite config — by the time this
 * runs it is already a string inside the bundle, and Babel cannot see into a
 * string literal.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse } from "acorn";

import { toEs5, parsesAsEs5 } from "./es5.mjs";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "assets");
const ENTRY = join(DIST, "index.js");
/** A string only the EPG worker contains, used to find it inside the bundle. */
const WORKER_MARKER = "could not inflate the EPG";

const source = readFileSync(ENTRY, "utf8");
const before = source.length;

let output = toEs5(source, "index.js");

/**
 * Lower the inlined EPG worker as well.
 *
 * The worker lives in the bundle as a string literal handed to a Blob, so the
 * pass above steps straight over it — to Babel it is just text.
 *
 * This was first attempted inside the Vite worker build, and it looked like it
 * worked: the plugin ran and its output parsed as ES5. But esbuild's minifier
 * runs afterwards and rewrites long strings containing "\n" into template
 * literals to save bytes, which put `_nonIterableRest` back to modern syntax
 * after Babel had lowered it. On the TV: `[epg] worker error: Unexpected token
 * =`. Doing it here, after every esbuild pass has finished, is the only place
 * nothing can undo it.
 */
const ast = parse(output, { ecmaVersion: 2020, sourceType: "script" });
const literal = findWorkerLiteral(ast);
if (!literal) {
  console.error(`transpile-es5: could not find the inlined worker (marker: ${WORKER_MARKER})`);
  process.exit(1);
}

const workerEs5 = toEs5(literal.value, "epg worker");
output = output.slice(0, literal.start) + jsStringLiteral(workerEs5) + output.slice(literal.end);

// Prove both halves, because both have silently regressed before.
if (!parsesAsEs5(output)) {
  console.error("transpile-es5: bundle is not ES5 after splicing the worker back in");
  process.exit(1);
}
if (!parsesAsEs5(workerEs5)) {
  console.error("transpile-es5: worker is not ES5");
  process.exit(1);
}

writeFileSync(ENTRY, output, "utf8");

const after = output.length;
const delta = (((after - before) / before) * 100).toFixed(1);
console.log(
  `transpiled to ES5: ${(before / 1024).toFixed(1)} kB -> ${(after / 1024).toFixed(1)} kB ` +
    `(${delta}%), including a ${(workerEs5.length / 1024).toFixed(1)} kB inlined worker`,
);

function findWorkerLiteral(root) {
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (
      node.type === "Literal" &&
      typeof node.value === "string" &&
      node.value.includes(WORKER_MARKER)
    ) {
      return node;
    }
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (Array.isArray(value)) stack.push(...value);
      else if (value && typeof value.type === "string") stack.push(value);
    }
  }
  return null;
}

/**
 * JSON.stringify, plus the two characters it leaves raw that ES5 forbids inside
 * a string literal. Missing these produces a bundle that will not parse.
 */
function jsStringLiteral(value) {
  // Built by char code rather than written literally: this file has to stay
  // pure ASCII. The separators are invisible characters that do not survive
  // ordinary editing, and a literal backslash here kept being eaten by the
  // shell heredoc that wrote this function.
  const escape = String.fromCharCode(0x5c) + "u";
  let out = "";
  const json = JSON.stringify(value);
  for (let i = 0; i < json.length; i++) {
    const code = json.charCodeAt(i);
    // U+2028/U+2029 are valid in JSON and JSON.stringify leaves them raw, but
    // they terminate a string literal in ES5. Without this the bundle will not
    // parse at all.
    out += code === 0x2028 || code === 0x2029 ? escape + code.toString(16) : json[i];
  }
  return out;
}
