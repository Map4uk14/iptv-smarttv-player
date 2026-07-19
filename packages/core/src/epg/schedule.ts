/**
 * Compact per-channel schedule storage.
 *
 * Storing programmes as objects is what makes EPG-heavy TV apps sluggish: an
 * object per programme means ~160k objects for this provider, each with its own
 * header, string pointers and GC cost. Instead each channel becomes a handful
 * of typed arrays plus a per-channel string table:
 *
 *   starts     Uint32Array   epoch seconds (Uint32, not Int32 — Int32 overflows
 *                            in 2038 and this is long-lived storage)
 *   ends       Uint32Array
 *   titleRefs  Uint32Array   index into `titles`
 *   descRefs   Int32Array    index into `descriptions`, -1 for none
 *
 * Titles are deduplicated *within a channel*, which is where the redundancy
 * actually lives — a news channel airs "Новости" dozens of times a week. The
 * measured dedup on this provider is 5.6x overall.
 *
 * The blob is self-contained per channel, deliberately: the guide can load only
 * the rows currently on screen instead of a global index. Descriptions are held
 * separately so they can be dropped or lazily loaded — they are ~60% of the
 * payload and are only needed when the info panel opens.
 *
 * Typed arrays also survive IndexedDB's structured clone without serialisation,
 * so storing and loading is close to a memcpy.
 */

import type { XmltvProgramme } from "./parseXmltv.ts";

export interface ChannelSchedule {
  readonly channelId: string;
  readonly starts: Uint32Array;
  readonly ends: Uint32Array;
  readonly titleRefs: Uint32Array;
  readonly descRefs: Int32Array;
  readonly titles: readonly string[];
  readonly descriptions: readonly string[];
}

export interface Programme {
  readonly channelId: string;
  readonly start: number;
  readonly stop: number;
  readonly title: string;
  readonly description?: string;
}

/** Accumulates programmes for one channel, then freezes into typed arrays. */
class ChannelBuilder {
  private readonly starts: number[] = [];
  private readonly ends: number[] = [];
  private readonly titleRefs: number[] = [];
  private readonly descRefs: number[] = [];
  private readonly titles: string[] = [];
  private readonly titleIndex = new Map<string, number>();
  private readonly descriptions: string[] = [];
  private readonly descIndex = new Map<string, number>();

  readonly channelId: string;

  constructor(channelId: string) {
    this.channelId = channelId;
  }

  add(programme: XmltvProgramme): void {
    this.starts.push(programme.start);
    this.ends.push(programme.stop);
    this.titleRefs.push(intern(programme.title, this.titles, this.titleIndex));
    this.descRefs.push(
      programme.description ? intern(programme.description, this.descriptions, this.descIndex) : -1,
    );
  }

  get length(): number {
    return this.starts.length;
  }

  build(): ChannelSchedule {
    // XMLTV is normally emitted in order, but nothing guarantees it, and every
    // lookup here is a binary search that would silently return wrong answers
    // on unsorted input. Sorting once at build time is far cheaper than a
    // linear scan per lookup, and `isSorted` makes the common case free.
    const order = this.sortedOrder();

    const n = this.starts.length;
    const starts = new Uint32Array(n);
    const ends = new Uint32Array(n);
    const titleRefs = new Uint32Array(n);
    const descRefs = new Int32Array(n);

    for (let i = 0; i < n; i++) {
      const j = order[i]!;
      starts[i] = this.starts[j]!;
      ends[i] = this.ends[j]!;
      titleRefs[i] = this.titleRefs[j]!;
      descRefs[i] = this.descRefs[j]!;
    }

    return {
      channelId: this.channelId,
      starts,
      ends,
      titleRefs,
      descRefs,
      titles: this.titles,
      descriptions: this.descriptions,
    };
  }

  private sortedOrder(): number[] {
    const n = this.starts.length;
    const order = new Array<number>(n);
    for (let i = 0; i < n; i++) order[i] = i;

    let sorted = true;
    for (let i = 1; i < n; i++) {
      if (this.starts[i]! < this.starts[i - 1]!) {
        sorted = false;
        break;
      }
    }
    if (sorted) return order;

    order.sort((a, b) => this.starts[a]! - this.starts[b]!);
    return order;
  }
}

/**
 * V8 minimum length for a sliced string; anything shorter is already copied.
 */
const SLICED_STRING_MIN = 13;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Force a flat copy of a string.
 *
 * `String.prototype.slice` does not copy in V8 — it returns a SlicedString that
 * points at its parent. A 30-character title sliced out of the EPG buffer
 * therefore keeps the *entire* surrounding megabyte of XML alive. Measured on
 * the real 286 MB feed, this pinned **674 MB retained** against a 23 MB index.
 *
 * Getting here took three wrong turns, recorded so they are not repeated:
 *
 *  1. `('' + s)`, `s.slice()`, `s.normalize()`, `s.padEnd(n)`, `s.repeat(1)`
 *     and `s.replace(/[\s\S]/g, m => m)` all look like copies and are not.
 *     They compile, read correctly, and free nothing.
 *  2. A synthetic benchmark said `JSON.parse(JSON.stringify(s))` was the
 *     fastest fix. It used a one-byte Latin-1 parent; the real EPG is Cyrillic,
 *     i.e. two-byte, where the result differed. Benchmark inputs must match the
 *     real data's string representation.
 *  3. Measuring several candidates in one process gave contradictory verdicts
 *     run to run — earlier allocations pollute later readings. Retention has to
 *     be measured one candidate per process.
 *
 * TextEncoder/TextDecoder round-trip was the only method that came out clean in
 * every measurement. It is genuinely a copy (through a byte buffer), portable
 * to both the browser and Node, and available on Chromium 53 (webOS 4.x).
 *
 * The authority on this is the "interned titles do not retain the source
 * buffer" test, not a micro-benchmark. If you change this, run that test with
 * --expose-gc.
 */
function flatten(value: string): string {
  if (value.length < SLICED_STRING_MIN) return value;
  return textDecoder.decode(textEncoder.encode(value));
}

function intern(value: string, table: string[], index: Map<string, number>): number {
  const existing = index.get(value);
  if (existing !== undefined) return existing;
  // Flatten only on first sight: the dictionary means this runs ~71k times for
  // 161k programmes, not once per programme.
  const flat = flatten(value);
  const ref = table.length;
  table.push(flat);
  // The map key must be the flattened copy too. Keying by the original slice
  // would keep the parent buffer alive through the map alone, defeating the
  // whole exercise. Lookups still hit because string equality is by content.
  index.set(flat, ref);
  return ref;
}

/**
 * Builds per-channel schedules from a stream of programmes.
 *
 * Memory during the build is proportional to the *kept* programmes, which is
 * why the parser's channel filter matters so much — it is applied upstream, so
 * discarded channels never reach a builder at all.
 */
export class EpgIndexBuilder {
  private readonly builders = new Map<string, ChannelBuilder>();

  add(programme: XmltvProgramme): void {
    let builder = this.builders.get(programme.channelId);
    if (!builder) {
      builder = new ChannelBuilder(programme.channelId);
      this.builders.set(programme.channelId, builder);
    }
    builder.add(programme);
  }

  get channelCount(): number {
    return this.builders.size;
  }

  get programmeCount(): number {
    let total = 0;
    for (const builder of this.builders.values()) total += builder.length;
    return total;
  }

  build(): Map<string, ChannelSchedule> {
    const result = new Map<string, ChannelSchedule>();
    for (const [id, builder] of this.builders) result.set(id, builder.build());
    return result;
  }
}

// --------------------------------------------------------------------------
// Queries. All binary search — the guide re-queries on every cursor move, so
// these run constantly and must not be linear.

function materialise(schedule: ChannelSchedule, i: number): Programme {
  const descRef = schedule.descRefs[i]!;
  const programme: { channelId: string; start: number; stop: number; title: string; description?: string } = {
    channelId: schedule.channelId,
    start: schedule.starts[i]!,
    stop: schedule.ends[i]!,
    title: schedule.titles[schedule.titleRefs[i]!] ?? "",
  };
  if (descRef >= 0) programme.description = schedule.descriptions[descRef] ?? "";
  return programme;
}

/** Index of the last programme starting at or before `time`, or -1. */
function floorIndex(starts: Uint32Array, time: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  let result = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (starts[mid]! <= time) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

/** The programme airing at `time`, or undefined if there is a gap. */
export function programmeAt(schedule: ChannelSchedule, time: number): Programme | undefined {
  const i = floorIndex(schedule.starts, time);
  if (i < 0) return undefined;
  // A hit on start does not guarantee a hit on the programme: guides have gaps.
  if (schedule.ends[i]! <= time) return undefined;
  return materialise(schedule, i);
}

/** Current and next programme — the "now/next" line in the channel list. */
export function nowAndNext(
  schedule: ChannelSchedule,
  time: number,
): { now?: Programme; next?: Programme } {
  const i = floorIndex(schedule.starts, time);
  const result: { now?: Programme; next?: Programme } = {};

  if (i >= 0 && schedule.ends[i]! > time) {
    result.now = materialise(schedule, i);
    if (i + 1 < schedule.starts.length) result.next = materialise(schedule, i + 1);
    return result;
  }
  // In a gap: there is no "now", and the next programme is the one after the
  // gap. Reporting a stale "now" here is a common and confusing bug.
  const nextIndex = i + 1;
  if (nextIndex < schedule.starts.length) result.next = materialise(schedule, nextIndex);
  return result;
}

/** All programmes overlapping [from, to) — one row of the guide grid. */
export function programmesBetween(
  schedule: ChannelSchedule,
  from: number,
  to: number,
): Programme[] {
  const result: Programme[] = [];
  // Start one before the floor: a programme that began earlier can still
  // overlap the window.
  let i = Math.max(0, floorIndex(schedule.starts, from));
  for (; i < schedule.starts.length; i++) {
    const start = schedule.starts[i]!;
    if (start >= to) break;
    if (schedule.ends[i]! > from) result.push(materialise(schedule, i));
  }
  return result;
}

/**
 * The programme immediately before or after the one starting at `fromStart`.
 *
 * Guide navigation steps between programmes rather than by pixels or fixed time
 * increments, because a cursor that lands in the middle of a box (or in a gap)
 * feels broken on a remote. `direction` is -1 or +1.
 */
export function adjacentProgramme(
  schedule: ChannelSchedule,
  fromStart: number,
  direction: -1 | 1,
): Programme | undefined {
  const i = floorIndex(schedule.starts, fromStart);
  // When `fromStart` is not itself a programme start (a gap, or a time carried
  // over from another channel), floorIndex gives the programme covering it, and
  // stepping from there is still the intuitive result.
  const target = i + direction;
  if (target < 0 || target >= schedule.starts.length) return undefined;
  return materialise(schedule, target);
}

/** First programme at or after `time` — used to seed the guide cursor. */
export function firstProgrammeFrom(
  schedule: ChannelSchedule,
  time: number,
): Programme | undefined {
  const i = floorIndex(schedule.starts, time);
  if (i >= 0 && schedule.ends[i]! > time) return materialise(schedule, i);
  const next = i + 1;
  return next < schedule.starts.length ? materialise(schedule, next) : undefined;
}

/** Approximate in-memory footprint in bytes, for diagnostics and budgeting. */
export function scheduleBytes(schedule: ChannelSchedule): number {
  let bytes =
    schedule.starts.byteLength +
    schedule.ends.byteLength +
    schedule.titleRefs.byteLength +
    schedule.descRefs.byteLength;
  for (const t of schedule.titles) bytes += t.length * 2;
  for (const d of schedule.descriptions) bytes += d.length * 2;
  return bytes;
}
