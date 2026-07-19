/**
 * EPG ingest worker.
 *
 * Runs off the UI thread because the real feed is 286 MB / 683k programmes and
 * takes ~6 seconds even on a laptop. On the main thread that would be six
 * seconds of frozen remote input — the exact behaviour that makes competing
 * apps feel broken.
 *
 * The gzip is inflated with `DecompressionStream` where available so the
 * decompressed XML never exists as a single buffer. Chunks are handed to the
 * streaming parser as they arrive and discarded immediately.
 */

import { XmltvStreamParser } from "../../../../packages/core/src/epg/parseXmltv.ts";
import { EpgIndexBuilder, type ChannelSchedule } from "../../../../packages/core/src/epg/schedule.ts";

export interface EpgRequest {
  url: string;
  /** tvg-ids actually used by loaded playlists. Discards ~77% on this feed. */
  channelIds: string[];
}

export type EpgResponse =
  | { type: "progress"; bytes: number; programmes: number }
  | { type: "done"; schedules: Map<string, ChannelSchedule>; stats: EpgDoneStats }
  | { type: "error"; message: string };

export interface EpgDoneStats {
  programmesSeen: number;
  programmesKept: number;
  channelsIndexed: number;
  elapsedMs: number;
}

const PROGRESS_INTERVAL_MS = 250;

self.onmessage = (event: MessageEvent<EpgRequest>) => {
  void run(event.data);
};

async function run(request: EpgRequest): Promise<void> {
  const started = Date.now();
  try {
    const response = await fetch(request.url);
    if (!response.ok) throw new Error(`EPG request failed: HTTP ${response.status}`);
    if (!response.body) throw new Error("EPG response has no readable body");

    const builder = new EpgIndexBuilder();
    const filter = new Set(request.channelIds);
    const parserOptions: ConstructorParameters<typeof XmltvStreamParser>[0] = {
      onProgramme: (programme) => builder.add(programme),
    };
    // Assigned conditionally rather than set to undefined: with
    // exactOptionalPropertyTypes an explicit undefined is not the same as
    // omitting the key, and an empty filter must mean "keep everything".
    if (filter.size > 0) parserOptions.channelFilter = filter;
    const parser = new XmltvStreamParser(parserOptions);

    let bytes = 0;
    let lastProgress = 0;

    // The DOM lib types DecompressionStream/TextDecoderStream writable sides as
    // BufferSource, which does not unify with ReadableStream<Uint8Array>. The
    // runtime pairing is correct; only the declarations disagree.
    const stream = decompressed(response.body, request.url);
    const reader = (stream as ReadableStream<Uint8Array>)
      .pipeThrough(new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>)
      .getReader();

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        bytes += value.length;
        parser.write(value);
      }
      const now = Date.now();
      if (now - lastProgress > PROGRESS_INTERVAL_MS) {
        lastProgress = now;
        post({ type: "progress", bytes, programmes: parser.stats.programmesKept });
      }
    }
    parser.end();

    const schedules = builder.build();
    post({
      type: "done",
      schedules,
      stats: {
        programmesSeen: parser.stats.programmesSeen,
        programmesKept: parser.stats.programmesKept,
        channelsIndexed: schedules.size,
        elapsedMs: Date.now() - started,
      },
    });
  } catch (error) {
    post({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Inflate the response when it is gzipped.
 *
 * The URL ending in `.gz` is a hint, not proof — and this provider serves the
 * EPG as `application/octet-stream`, so Content-Type says nothing either. Some
 * servers also set `Content-Encoding: gzip`, in which case fetch has already
 * inflated it and doing so again would fail. Sniffing the gzip magic bytes
 * would be strictly better; that is a known gap, noted rather than hidden.
 */
function decompressed(body: ReadableStream<Uint8Array>, url: string): ReadableStream<Uint8Array> {
  const looksGzipped = /\.gz(\?|$)/i.test(url);
  if (!looksGzipped) return body;
  if (typeof DecompressionStream === "undefined") {
    // webOS 4.x (Chromium 53) predates DecompressionStream. Falling back means
    // the EPG is unavailable there rather than the app crashing; a JS inflate
    // is the planned fix.
    throw new Error("This TV cannot decompress gzipped EPG data (DecompressionStream unavailable)");
  }
  return body.pipeThrough(
    new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>,
  );
}

function post(message: EpgResponse): void {
  (self as unknown as { postMessage: (m: EpgResponse) => void }).postMessage(message);
}
