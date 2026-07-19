/**
 * EPG grid — channels down, time across.
 *
 * Virtualized on both axes, for different reasons:
 *  - vertically because a playlist can be 20,000 channels;
 *  - horizontally because a channel has ~380 programmes over the 22-day feed,
 *    and only the ones intersecting the visible window are ever built.
 *
 * Layout is arithmetic from a constant pixels-per-minute, so a programme's box
 * is derived from its start/stop rather than measured. No reflow while moving
 * the cursor.
 *
 * Navigation follows programmes, not pixels: left/right steps to the adjacent
 * programme and drags the window along if it falls outside. Scrolling a TV grid
 * by fixed pixel amounts feels broken because the cursor lands between items.
 */

import { createMemo, For, Show } from "solid-js";
import type { Channel } from "../../../../packages/core/src/playlist/types.ts";
import {
  programmesBetween,
  type ChannelSchedule,
  type Programme,
} from "../../../../packages/core/src/epg/schedule.ts";

export const GUIDE_ROW_HEIGHT = 78;
export const PX_PER_MINUTE = 7;
const OVERSCAN_ROWS = 2;
const CHANNEL_COLUMN_WIDTH = 330;

export interface GuideSelection {
  readonly channelIndex: number;
  readonly programme: Programme | null;
}

interface Props {
  readonly channels: readonly Channel[];
  readonly selection: GuideSelection;
  readonly windowStart: number;
  readonly windowMinutes: number;
  readonly viewportHeight: number;
  readonly nowSeconds: number;
  readonly getSchedule: (channel: Channel) => ChannelSchedule | undefined;
  readonly isFavourite: (channel: Channel) => boolean;
  readonly onActivate: (channelIndex: number, programme: Programme | null) => void;
}

function clockTime(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function dayLabel(epochSeconds: number, nowSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const today = new Date(nowSeconds * 1000);
  const midnight = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDelta = Math.round((midnight(d) - midnight(today)) / 86400000);
  if (dayDelta === 0) return "Today";
  if (dayDelta === -1) return "Yesterday";
  if (dayDelta === 1) return "Tomorrow";
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

export function Guide(props: Props) {
  const windowEnd = createMemo(() => props.windowStart + props.windowMinutes * 60);

  const scrollTop = createMemo(() => {
    const centre = Math.floor(props.viewportHeight / 2 - GUIDE_ROW_HEIGHT / 2);
    const raw = props.selection.channelIndex * GUIDE_ROW_HEIGHT - centre;
    const max = Math.max(0, props.channels.length * GUIDE_ROW_HEIGHT - props.viewportHeight);
    return Math.min(Math.max(0, raw), max);
  });

  const visibleRows = createMemo(() => {
    const count = Math.ceil(props.viewportHeight / GUIDE_ROW_HEIGHT) + 1;
    const start = Math.max(0, Math.floor(scrollTop() / GUIDE_ROW_HEIGHT) - OVERSCAN_ROWS);
    const end = Math.min(props.channels.length, start + count + OVERSCAN_ROWS * 2);
    const rows = [];
    for (let i = start; i < end; i++) rows.push({ channel: props.channels[i]!, index: i });
    return rows;
  });

  /** Half-hour tick marks across the header. */
  const ticks = createMemo(() => {
    const marks: { time: number; left: number }[] = [];
    const firstTick = Math.ceil(props.windowStart / 1800) * 1800;
    for (let t = firstTick; t < windowEnd(); t += 1800) {
      marks.push({ time: t, left: ((t - props.windowStart) / 60) * PX_PER_MINUTE });
    }
    return marks;
  });

  const nowLeft = createMemo(() => ((props.nowSeconds - props.windowStart) / 60) * PX_PER_MINUTE);

  const box = (programme: Programme): { left: number; width: number } => {
    // Clamp to the window so a programme that starts before it still renders a
    // correctly-sized visible portion.
    const start = Math.max(programme.start, props.windowStart);
    const stop = Math.min(programme.stop, windowEnd());
    return {
      left: ((start - props.windowStart) / 60) * PX_PER_MINUTE,
      width: Math.max(2, ((stop - start) / 60) * PX_PER_MINUTE),
    };
  };

  return (
    <div class="guide">
      <div class="guide-header" style={{ "padding-left": `${CHANNEL_COLUMN_WIDTH}px` }}>
        <div class="guide-daylabel">{dayLabel(props.windowStart, props.nowSeconds)}</div>
        <div class="guide-ticks" style={{ width: `${props.windowMinutes * PX_PER_MINUTE}px` }}>
          <For each={ticks()}>
            {(tick) => (
              <div class="guide-tick" style={{ left: `${tick.left}px` }}>
                {clockTime(tick.time)}
              </div>
            )}
          </For>
        </div>
      </div>

      <div class="guide-body" style={{ height: `${props.viewportHeight}px` }}>
        {/* The now-line is absolute over the whole grid, drawn once rather than
            per row, and hidden when the window is scrolled away from it. */}
        <Show when={nowLeft() >= 0 && nowLeft() <= props.windowMinutes * PX_PER_MINUTE}>
          <div class="guide-nowline" style={{ left: `${CHANNEL_COLUMN_WIDTH + nowLeft()}px` }} />
        </Show>

        <div
          class="guide-scroll"
          style={{
            transform: `translateY(${-scrollTop()}px)`,
            height: `${props.channels.length * GUIDE_ROW_HEIGHT}px`,
          }}
        >
          <For each={visibleRows()}>
            {(row) => {
              const schedule = createMemo(() => props.getSchedule(row.channel));
              const programmes = createMemo(() => {
                const s = schedule();
                if (!s) return [];
                return programmesBetween(s, props.windowStart, windowEnd());
              });

              return (
                <div
                  class="guide-row"
                  classList={{ current: row.index === props.selection.channelIndex }}
                  style={{ top: `${row.index * GUIDE_ROW_HEIGHT}px`, height: `${GUIDE_ROW_HEIGHT}px` }}
                >
                  <div class="guide-channel" style={{ width: `${CHANNEL_COLUMN_WIDTH}px` }}>
                    <div class="guide-channel-number">{row.channel.channelNumber ?? row.index + 1}</div>
                    <Show
                      when={row.channel.logo}
                      fallback={<div class="guide-channel-logo-fallback" />}
                    >
                      <img class="guide-channel-logo" src={row.channel.logo} alt="" decoding="async" />
                    </Show>
                    <div class="guide-channel-name">{row.channel.name}</div>
                    <Show when={props.isFavourite(row.channel)}>
                      <span class="guide-channel-fav">★</span>
                    </Show>
                  </div>

                  <div class="guide-track" style={{ width: `${props.windowMinutes * PX_PER_MINUTE}px` }}>
                    <Show
                      when={programmes().length > 0}
                      fallback={<div class="guide-nodata">No guide data</div>}
                    >
                      <For each={programmes()}>
                        {(programme) => {
                          const geometry = box(programme);
                          const selected = (): boolean =>
                            row.index === props.selection.channelIndex &&
                            props.selection.programme?.start === programme.start;
                          const isPast = (): boolean => programme.stop <= props.nowSeconds;
                          const hasArchive = (): boolean =>
                            isPast() &&
                            !!row.channel.catchup &&
                            row.channel.catchup.days > 0 &&
                            programme.start >= props.nowSeconds - row.channel.catchup.days * 86400;

                          return (
                            <div
                              class="guide-programme"
                              classList={{
                                selected: selected(),
                                past: isPast(),
                                // Past programmes still inside the archive
                                // window are replayable; the rest are not, and
                                // the difference must be visible before the
                                // user presses OK.
                                archived: hasArchive(),
                              }}
                              style={{ left: `${geometry.left}px`, width: `${geometry.width - 3}px` }}
                              onClick={() => props.onActivate(row.index, programme)}
                            >
                              <div class="guide-programme-title">{programme.title}</div>
                              <div class="guide-programme-time">
                                {clockTime(programme.start)}
                                <Show when={hasArchive()}>
                                  <span class="guide-archive-badge">⟲</span>
                                </Show>
                              </div>
                            </div>
                          );
                        }}
                      </For>
                    </Show>
                  </div>
                </div>
              );
            }}
          </For>
        </div>
      </div>
    </div>
  );
}
