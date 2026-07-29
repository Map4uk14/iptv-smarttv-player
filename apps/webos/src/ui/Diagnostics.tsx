/**
 * On-screen layout diagnostics.
 *
 * The TV's DevTools console cannot be typed into — Enter does not evaluate — so
 * measurements have to reach us some other way. This paints them onto the TV
 * itself, to be read off a photograph.
 *
 * Deliberately built out of nothing that could itself be a casualty of the
 * engine's age: absolute longhand offsets, no flexbox, no `gap`, inline styles
 * only. If this panel renders but the app around it does not, that is a result
 * in itself.
 *
 * Temporary. Remove once the layout question is settled.
 */

import { createSignal, onCleanup, onMount } from "solid-js";

/** Elements whose measured size distinguishes the competing explanations. */
const TARGETS = [
  ".app",
  ".browse",
  ".browse-header",
  ".browse-body",
  ".sidebar",
  ".browse-main",
  ".channel-list",
  ".channel-row",
  ".channel-meta",
  ".video-host",
  "video",
];

function measure(): string[] {
  const out: string[] = [];
  out.push(`win ${window.innerWidth}x${window.innerHeight}  dpr ${window.devicePixelRatio}`);

  const chrome = /Chrome\/(\d+)/.exec(navigator.userAgent);
  const webos = /Web[O0]S[^;)]*/i.exec(navigator.userAgent);
  out.push(`chrome ${chrome ? chrome[1] : "?"}  ${webos ? webos[0] : "webOS ?"}`);

  for (const selector of TARGETS) {
    const el = document.querySelector(selector) as HTMLElement | null;
    out.push(`${selector} ${el ? `${el.offsetWidth}x${el.offsetHeight}` : "(absent)"}`);
  }
  return out;
}

export function Diagnostics() {
  const [lines, setLines] = createSignal<string[]>([]);

  onMount(() => {
    // Deferred, then polled: the first paint happens before the channel rows
    // exist, and a size read at mount would measure the wrong moment.
    const tick = () => setLines(measure());
    const timer = window.setInterval(tick, 1000);
    window.setTimeout(tick, 100);
    onCleanup(() => window.clearInterval(timer));
  });

  return (
    <div
      style={{
        position: "absolute",
        top: "0px",
        left: "0px",
        "z-index": "999",
        padding: "10px 14px",
        background: "#000000",
        border: "2px solid #ffb224",
        color: "#ffe08a",
        "font-family": "monospace",
        "font-size": "20px",
        "line-height": "1.35",
      }}
    >
      {lines().map((line) => (
        <div>{line}</div>
      ))}
    </div>
  );
}
