/**
 * Production stand-in for hls.js.
 *
 * The dev-only playback fallback is behind an `import.meta.env.DEV` guard, but
 * that alone does NOT keep hls.js out of the bundle: Rollup still resolves the
 * dynamic import and emits a real chunk for it (verified — the bundle check
 * caught exactly this). So production builds alias `hls.js` to this stub, and
 * scripts/check-bundle.mjs asserts no genuine hls.js code survives.
 *
 * Nothing here ever runs on the TV: the only caller sits in a branch that is
 * statically false in production.
 */

class HlsStub {
  static isSupported(): boolean {
    return false;
  }
  static readonly Events = { MANIFEST_PARSED: "manifestParsed", ERROR: "hlsError" };
  loadSource(): void {}
  attachMedia(): void {}
  on(): void {}
  destroy(): void {}
}

export default HlsStub;
