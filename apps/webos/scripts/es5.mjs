/**
 * Lower JavaScript to ES5, and prove it.
 *
 * Shared by the post-build transpile (the main bundle) and the Vite worker
 * plugin (the EPG worker, which must be ES5 *before* it is inlined as a string).
 *
 * A single Babel pass is not enough. Babel injects its runtime helpers after the
 * transform, so the helpers themselves are not lowered — `_nonIterableRest`
 * arrived carrying a template literal, which Chromium 38 cannot parse. That
 * failed as a worker which threw `Unexpected token =` on the TV while the build
 * reported success.
 *
 * So the pass repeats until acorn agrees the result is ES5, and throws if it
 * cannot get there. Verifying the output rather than trusting the transform is
 * the whole point — the previous version trusted it and shipped modern syntax.
 */

import { transformSync } from "@babel/core";
import { parse } from "acorn";

const MAX_PASSES = 4;

export function parsesAsEs5(code) {
  try {
    parse(code, { ecmaVersion: 5, sourceType: "script" });
    return true;
  } catch {
    return false;
  }
}

/** Babel-lower `code` until it parses as ES5. Returns the lowered source. */
export function toEs5(code, label = "bundle") {
  let current = code;

  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    if (parsesAsEs5(current)) return current;

    const result = transformSync(current, {
      babelrc: false,
      configFile: false,
      compact: true,
      sourceType: "script",
      presets: [
        [
          "@babel/preset-env",
          {
            // Chromium 38 is webOS 3.x — measured on the device, not guessed
            // from a release table.
            targets: { chrome: "38" },
            // Polyfills are real imports (src/polyfills.ts on the main thread,
            // core-js/stable in the worker). Letting preset-env inject them here
            // would emit require() calls into a plain script.
            useBuiltIns: false,
            bugfixes: true,
          },
        ],
      ],
    });

    if (!result || typeof result.code !== "string") {
      throw new Error(`${label}: Babel returned no code on pass ${pass}`);
    }
    current = result.code;
  }

  if (parsesAsEs5(current)) return current;

  // Report where it still fails; "could not lower" alone means grepping a
  // 600 kB minified file by hand.
  let detail = "";
  try {
    parse(current, { ecmaVersion: 5, sourceType: "script" });
  } catch (error) {
    const at = typeof error.pos === "number" ? error.pos : 0;
    detail = `\n  ${error.message}\n  near: ${JSON.stringify(
      current.slice(Math.max(0, at - 80), at + 80),
    )}`;
  }
  throw new Error(`${label}: still not ES5 after ${MAX_PASSES} passes${detail}`);
}
