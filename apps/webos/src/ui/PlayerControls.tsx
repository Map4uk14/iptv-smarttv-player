/**
 * Transport controls for live and archive playback.
 *
 * The scrub bar spans the *current programme*, not the whole archive. A bar
 * covering 7 days makes a 30-second skip an invisible sub-pixel movement; a bar
 * covering one programme gives the user something they can actually aim at.
 * Seeking beyond either end rolls into the adjacent programme.
 *
 * Two positions are shown at once while scrubbing: where playback actually is,
 * and where the cursor is pointing. Seeking is committed on a debounce rather
 * than per keypress, because each seek re-requests the stream — and this
 * provider caps concurrent connections at two.
 */

import { Show } from "solid-js";
import type { Channel } from "../../../../packages/core/src/playlist/types.ts";
import type { Programme } from "../../../../packages/core/src/epg/schedule.ts";

interface Props {
  readonly channel: Channel | undefined;
  readonly programme: Programme | undefined;
  /** Wall-clock position of what is on screen, epoch seconds. */
  readonly position: number;
  /** Scrub target while seeking, epoch seconds; null when not seeking. */
  readonly seekTarget: number | null;
  readonly paused: boolean;
  readonly live: boolean;
  /** True when the channel has no archive, so seeking is impossible. */
  readonly seekDisabled: boolean;
  readonly nowSeconds: number;
}

function clockTime(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function offsetLabel(behindSeconds: number): string {
  if (behindSeconds < 60) return "LIVE";
  const minutes = Math.round(behindSeconds / 60);
  if (minutes < 60) return `−${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `−${hours} h` : `−${hours} h ${rest} min`;
}

export function PlayerControls(props: Props) {
  // Fall back to a one-hour window around the position when the channel has no
  // guide data, so the bar still means something.
  const windowStart = (): number => props.programme?.start ?? props.position - 1800;
  const windowEnd = (): number => props.programme?.stop ?? props.position + 1800;

  const fraction = (time: number): number => {
    const span = windowEnd() - windowStart();
    if (span <= 0) return 0;
    return Math.min(1, Math.max(0, (time - windowStart()) / span));
  };

  const behind = (): number => Math.max(0, props.nowSeconds - props.position);

  return (
    <div class="controls">
      <div class="controls-head">
        <div class="controls-state">
          <span class="controls-icon">{props.paused ? "❚❚" : "▶"}</span>
          <span class="controls-channel">{props.channel?.name ?? ""}</span>
        </div>
        <div class="controls-offset" classList={{ live: props.live && behind() < 60 }}>
          {props.live && behind() < 60 ? "● LIVE" : offsetLabel(behind())}
        </div>
      </div>

      <div class="controls-programme">
        <Show when={props.programme} fallback={<span class="muted">No guide data</span>}>
          {(current) => (
            <>
              <span class="controls-programme-title">{current().title}</span>
              <span class="controls-programme-time">
                {clockTime(current().start)}–{clockTime(current().stop)}
              </span>
            </>
          )}
        </Show>
      </div>

      <div class="controls-bar">
        <span class="controls-time">{clockTime(windowStart())}</span>

        <div class="controls-track">
          <div class="controls-elapsed" style={{ width: `${fraction(props.position) * 100}%` }} />

          {/* Where playback actually is. */}
          <div class="controls-head-marker" style={{ left: `${fraction(props.position) * 100}%` }} />

          {/* Where the cursor is pointing, shown only while scrubbing so the
              user can see the target before committing to it. */}
          <Show when={props.seekTarget !== null}>
            <div class="controls-seek-marker" style={{ left: `${fraction(props.seekTarget!) * 100}%` }}>
              <div class="controls-seek-label">{clockTime(props.seekTarget!)}</div>
            </div>
          </Show>
        </div>

        <span class="controls-time">{clockTime(windowEnd())}</span>
      </div>

      <div class="controls-hints">
        <Show
          when={!props.seekDisabled}
          fallback={<span class="controls-warn">This channel has no archive — seeking unavailable</span>}
        >
          <span>◀▶ Skip 30s · hold to scrub</span>
          <span>❚❚ Pause</span>
          <Show when={!props.live || behind() >= 60}>
            <span class="controls-jump">
              <span class="legend-dot blue" /> Back to live
            </span>
          </Show>
        </Show>
      </div>
    </div>
  );
}
