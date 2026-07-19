/**
 * Playback info overlay.
 *
 * Appears on channel change and on OK/INFO, then auto-hides. Everything here is
 * about orientation after a zap: which channel, what is on, how far through it
 * is, and what follows.
 */

import { Show } from "solid-js";
import type { Channel } from "../../../../packages/core/src/playlist/types.ts";
import type { Programme } from "../../../../packages/core/src/epg/schedule.ts";
import type { PlaybackStatus } from "../platform/player.ts";

interface Props {
  readonly channel: Channel | undefined;
  readonly channelNumber: number;
  // Explicitly `| undefined` rather than optional: under
  // exactOptionalPropertyTypes an absent prop and an explicit undefined are
  // different types, and these are always passed.
  readonly now: Programme | undefined;
  readonly next: Programme | undefined;
  /** Wall-clock position of what is on screen (reconstructed during catchup). */
  readonly nowSeconds: number;
  readonly status: PlaybackStatus;
  readonly catchup?: boolean;
}

function clockTime(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function InfoBar(props: Props) {
  const progress = (): number => {
    const current = props.now;
    if (!current) return 0;
    const span = current.stop - current.start;
    if (span <= 0) return 0;
    return Math.min(1, Math.max(0, (props.nowSeconds - current.start) / span));
  };

  const remaining = (): string => {
    const current = props.now;
    if (!current) return "";
    const minutes = Math.max(0, Math.round((current.stop - props.nowSeconds) / 60));
    return `${minutes} min left`;
  };

  return (
    <div class="infobar">
      <div class="infobar-head">
        <div class="infobar-number">{props.channelNumber}</div>
        <Show when={props.channel?.logo}>
          <img class="infobar-logo" src={props.channel!.logo} alt="" decoding="async" />
        </Show>
        <div class="infobar-titles">
          <div class="infobar-channel">
            {props.channel?.name ?? ""}
            <Show when={props.catchup}>
              {/* Being on archive rather than live must be unmistakable —
                  otherwise the clock reading "two hours ago" looks like a bug. */}
              <span class="infobar-badge">⟲ Replay</span>
            </Show>
          </div>
          <Show
            when={props.now}
            fallback={<div class="infobar-programme muted">No guide data for this channel</div>}
          >
            {(current) => (
              <div class="infobar-programme">
                {clockTime(current().start)}–{clockTime(current().stop)} · {current().title}
              </div>
            )}
          </Show>
        </div>
        <div class="infobar-clock">{clockTime(props.nowSeconds)}</div>
      </div>

      <Show when={props.now}>
        <div class="infobar-progress">
          <div class="progress-track wide">
            <div class="progress-fill" style={{ width: `${progress() * 100}%` }} />
          </div>
          <div class="infobar-remaining">{remaining()}</div>
        </div>
      </Show>

      {/* An absent description renders as an explicit line rather than empty
          space. 26 of this provider's 297 channels (mostly rolling news) ship
          no synopsis at all, and silently collapsing the row makes missing
          upstream data look like a broken app. */}
      <Show when={props.now}>
        <Show
          when={props.now?.description}
          fallback={<div class="infobar-desc empty">No description provided for this programme</div>}
        >
          {(description) => <div class="infobar-desc">{description()}</div>}
        </Show>
      </Show>

      <div class="infobar-foot">
        <Show when={props.next}>
          {(upcoming) => (
            <span class="infobar-next">
              Next · {clockTime(upcoming().start)} {upcoming().title}
            </span>
          )}
        </Show>
        {/* Playback strategy is surfaced deliberately: it is the one webOS
            media question documentation could not settle, so the first run on
            real hardware needs to report which source form worked. */}
        <span class="infobar-status">
          {props.status.state}
          {props.status.strategy ? ` · ${props.status.strategy}` : ""}
        </span>
      </div>
    </div>
  );
}
