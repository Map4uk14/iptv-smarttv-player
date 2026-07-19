/**
 * Virtualized channel list with now/next EPG.
 *
 * Built rather than imported because TV lists have requirements desktop
 * virtualizers do not meet: selection is driven by D-pad rather than scroll
 * position, the selected row stays parked at a stable screen position, and a
 * 20,000-row playlist must not put 20,000 nodes in the DOM. Rows are
 * fixed-height, so the visible window is pure arithmetic — no measurement, no
 * layout thrash.
 *
 * EPG is read through a callback rather than baked into the channel objects, so
 * the guide can arrive after the list has already rendered. That ordering is
 * what lets the app show channels instantly and fill in programmes as the index
 * finishes.
 */

import { createMemo, For, Show } from "solid-js";
import type { Channel } from "../../../../packages/core/src/playlist/types.ts";
import type { Programme } from "../../../../packages/core/src/epg/schedule.ts";

export const ROW_HEIGHT = 76;
const OVERSCAN = 4;

export interface NowNext {
  now?: Programme;
  next?: Programme;
}

interface Props {
  readonly channels: readonly Channel[];
  readonly selectedIndex: number;
  readonly viewportHeight: number;
  readonly focused: boolean;
  readonly nowSeconds: number;
  readonly getNowNext: (channel: Channel) => NowNext;
  readonly isFavourite: (channel: Channel) => boolean;
  readonly onActivate: (index: number) => void;
}

function clockTime(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function ChannelList(props: Props) {
  const visibleCount = createMemo(() => Math.ceil(props.viewportHeight / ROW_HEIGHT) + 1);

  // Keep the selection roughly centred so there is always context above and
  // below, except at the ends of the list where clamping takes over.
  const scrollTop = createMemo(() => {
    const centre = Math.floor(props.viewportHeight / 2 - ROW_HEIGHT / 2);
    const raw = props.selectedIndex * ROW_HEIGHT - centre;
    const max = Math.max(0, props.channels.length * ROW_HEIGHT - props.viewportHeight);
    return Math.min(Math.max(0, raw), max);
  });

  const slice = createMemo(() => {
    const start = Math.max(0, Math.floor(scrollTop() / ROW_HEIGHT) - OVERSCAN);
    const end = Math.min(props.channels.length, start + visibleCount() + OVERSCAN * 2);
    const rows = [];
    for (let i = start; i < end; i++) rows.push({ channel: props.channels[i]!, index: i });
    return rows;
  });

  return (
    <div class="channel-list" style={{ height: `${props.viewportHeight}px` }}>
      <div
        class="channel-list-inner"
        style={{
          transform: `translateY(${-scrollTop()}px)`,
          height: `${props.channels.length * ROW_HEIGHT}px`,
        }}
      >
        <For each={slice()}>
          {(item) => {
            const epg = createMemo(() => props.getNowNext(item.channel));
            const progress = createMemo(() => {
              const current = epg().now;
              if (!current) return 0;
              const span = current.stop - current.start;
              if (span <= 0) return 0;
              return Math.min(1, Math.max(0, (props.nowSeconds - current.start) / span));
            });

            return (
              <div
                class="channel-row"
                classList={{
                  selected: item.index === props.selectedIndex,
                  // Dim the selection when focus is elsewhere, so it is always
                  // obvious which column the remote is driving.
                  inactive: item.index === props.selectedIndex && !props.focused,
                }}
                style={{ top: `${item.index * ROW_HEIGHT}px`, height: `${ROW_HEIGHT}px` }}
                onClick={() => props.onActivate(item.index)}
              >
                <div class="channel-number">{item.channel.channelNumber ?? item.index + 1}</div>

                <div class="channel-logo">
                  <Show
                    when={item.channel.logo}
                    fallback={<div class="channel-logo-fallback">{item.channel.name.slice(0, 2)}</div>}
                  >
                    {/* Decoding is the expensive part on a TV; async keeps it
                        off the critical path while scrolling. */}
                    <img src={item.channel.logo} alt="" loading="lazy" decoding="async" />
                  </Show>
                </div>

                <div class="channel-meta">
                  <div class="channel-line">
                    <span class="channel-name">{item.channel.name}</span>
                    <Show when={props.isFavourite(item.channel)}>
                      <span class="channel-fav" aria-label="Favourite">
                        ★
                      </span>
                    </Show>
                  </div>

                  <Show
                    when={epg().now}
                    fallback={<div class="channel-programme muted">No guide data</div>}
                  >
                    {(current) => (
                      <div class="channel-programme">
                        <span class="programme-time">{clockTime(current().start)}</span>
                        <span class="programme-title">{current().title}</span>
                      </div>
                    )}
                  </Show>
                </div>

                <div class="channel-right">
                  <Show when={epg().now}>
                    <div class="progress-track">
                      <div class="progress-fill" style={{ width: `${progress() * 100}%` }} />
                    </div>
                  </Show>
                  <Show when={epg().next}>
                    {(upcoming) => (
                      <div class="channel-next">
                        Next {clockTime(upcoming().start)} · {upcoming().title}
                      </div>
                    )}
                  </Show>
                </div>
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );
}
