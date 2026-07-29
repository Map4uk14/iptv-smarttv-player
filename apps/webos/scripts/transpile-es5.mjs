/**
 * Lower the built bundle to ES5.
 *
 * The reference TV's engine is older than Chromium 45: it rejects the bundle
 * with `SyntaxError: Unexpected token =>` before a single line runs, which
 * presents as a black screen. Vite's `build.target` cannot solve this on its
 * own — esbuild refuses to lower async/await to ES5 ("Transforming async
 * functions to the configured target environment is not supported yet"), and
 * this app is async throughout. So esbuild takes it as far as it can and Babel
 * finishes the job here, on the emitted bundle.
 *
 * Running after the bundler rather than as a Vite plugin is deliberate: it
 * transforms exactly what ships, including whatever Vite's own runtime helpers
 * inject, and leaves the dev server untouched.
 *
 * Not covered: the EPG worker, which Vite has already base64-inlined into a
 * string by this point, so Babel cannot see it. That worker needs
 * DecompressionStream (Chromium 80) regardless, so on this TV it is dead either
 * way; EpgService reports the failure and the app runs without a guide.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { transformSync } from "@babel/core";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "assets");
const ENTRY = join(DIST, "index.js");

const source = readFileSync(ENTRY, "utf8");
const before = source.length;

const result = transformSync(source, {
  filename: ENTRY,
  babelrc: false,
  configFile: false,
  compact: true,
  sourceType: "script", // an IIFE bundle, not a module
  presets: [
    [
      "@babel/preset-env",
      {
        // Chrome 38 is webOS 3.x. Targeting it rather than the exact engine
        // because the TV only told us "=> is unexpected"; this is the oldest
        // baseline that still runs Solid without Proxy, which cannot be
        // polyfilled. The bundle uses no Proxy — checked before committing to
        // this path.
        targets: { chrome: "38" },
        // Polyfills come from src/polyfills.ts as real imports. Letting
        // preset-env inject them here would emit require() calls into a plain
        // script, where they cannot resolve.
        useBuiltIns: false,
        bugfixes: true,
      },
    ],
  ],
});

if (!result || typeof result.code !== "string") {
  console.error("transpile-es5: Babel returned no code");
  process.exit(1);
}

writeFileSync(ENTRY, result.code, "utf8");

const after = result.code.length;
const delta = (((after - before) / before) * 100).toFixed(1);
console.log(
  `transpiled to ES5: ${(before / 1024).toFixed(1)} kB -> ${(after / 1024).toFixed(1)} kB (${delta}%)`,
);
