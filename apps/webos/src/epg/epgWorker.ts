/**
 * EPG ingest worker.
 *
 * Runs off the UI thread because the real feed is 286 MB / 683k programmes and
 * takes ~6 seconds even on a laptop. On the main thread that would be six
 * seconds of frozen remote input — the exact behaviour that makes competing
 * apps feel broken.
 *
 * Everything here is written for a 2014 engine, which rules out the obvious
 * implementation:
 *
 *   fetch + ReadableStream   Chromium 42 / 43 — absent, and the polyfill on the
 *                            main thread does not reach a worker's own global
 *   DecompressionStream      Chromium 80 — absent
 *   async / await            transpiles to ES5 only via regenerator; avoided
 *                            entirely so the inlined worker stays small
 *
 * So: XMLHttpRequest (which has been in workers forever and reports progress),
 * pako for the inflate, and plain callbacks.
 *
 * The important property is preserved — the decompressed XML never exists as a
 * single buffer. pako emits chunks as it inflates and each one is parsed and
 * discarded. Only the compressed download (~30 MB) is held whole.
 */

import "core-js/stable";
import { Inflate } from "pako";

import { Utf8StreamDecoder } from "../../../../packages/core/src/epg/utf8.ts";
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

/**
 * Compressed bytes pushed into the inflater per turn.
 *
 * Small enough that each pass yields quickly and progress keeps moving, large
 * enough not to pay per-call overhead 30,000 times.
 */
const INFLATE_SLICE = 1 << 20; // 1 MiB

self.onmessage = (event: MessageEvent<EpgRequest>) => {
  run(event.data);
};

function run(request: EpgRequest): void {
  const started = Date.now();

  download(
    request.url,
    (buffer) => {
      try {
        index(buffer, request, started);
      } catch (error) {
        fail(error);
      }
    },
    fail,
  );
}

function index(buffer: ArrayBuffer, request: EpgRequest, started: number): void {
  const builder = new EpgIndexBuilder();

  const filter = new Set<string>();
  // Built by loop rather than `new Set(array)`: the iterable constructor is not
  // dependable on the oldest engines this has to run on.
  for (let i = 0; i < request.channelIds.length; i++) filter.add(request.channelIds[i]!);

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
  const tick = (): void => {
    const now = Date.now();
    if (now - lastProgress > PROGRESS_INTERVAL_MS) {
      lastProgress = now;
      post({ type: "progress", bytes, programmes: parser.stats.programmesKept });
    }
  };

  const source = new Uint8Array(buffer);
  const decoder = makeDecoder();

  const feed = (chunk: Uint8Array): void => {
    const text = decoder.decode(chunk);
    if (text.length === 0) return;
    bytes += text.length;
    parser.write(text);
    tick();
  };

  if (isGzip(source)) {
    // pako emits bytes, not text: `to: "string"` was removed in pako 2.0. So a
    // character can and does straddle two inflate chunks, which is what the
    // decoder above is for.
    const inflater = new Inflate();
    inflater.onData = (chunk: unknown) => feed(chunk as Uint8Array);

    for (let offset = 0; offset < source.length; offset += INFLATE_SLICE) {
      const end = Math.min(offset + INFLATE_SLICE, source.length);
      inflater.push(source.subarray(offset, end), end >= source.length);
      if (inflater.err) throw new Error(`could not inflate the EPG: ${inflater.msg}`);
    }
  } else {
    // Not compressed. Sliced for the same reason — one 286 MB string is not
    // something this device can hold.
    for (let offset = 0; offset < source.length; offset += INFLATE_SLICE) {
      feed(source.subarray(offset, Math.min(offset + INFLATE_SLICE, source.length)));
    }
  }

  const trailing = decoder.end();
  if (trailing.length > 0) parser.write(trailing);
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
}

/**
 * Gzip magic number.
 *
 * The previous version decided by looking for `.gz` in the URL, which was
 * guesswork: this provider serves the EPG as `application/octet-stream`, so the
 * Content-Type says nothing, and some servers set `Content-Encoding: gzip` and
 * hand back already-inflated bytes. The first two bytes are the actual answer.
 */
function isGzip(bytes: Uint8Array): boolean {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

interface StreamDecoder {
  decode(bytes: Uint8Array): string;
  end(): string;
}

/**
 * Prefer the platform decoder, fall back to ours.
 *
 * TextDecoder is faster and is what the tests treat as the oracle, but it is not
 * dependable on Chromium 38. Both paths must handle a character split across a
 * chunk boundary — hence `stream: true`, without which the native path would be
 * the buggier of the two.
 */
function makeDecoder(): StreamDecoder {
  if (typeof TextDecoder !== "undefined") {
    const native = new TextDecoder("utf-8");
    return {
      decode: (bytes) => native.decode(bytes, { stream: true }),
      end: () => native.decode(),
    };
  }
  return new Utf8StreamDecoder();
}

function download(
  url: string,
  onDone: (buffer: ArrayBuffer) => void,
  onError: (error: unknown) => void,
): void {
  const request = new XMLHttpRequest();
  request.open("GET", url, true);
  request.responseType = "arraybuffer";
  request.onload = () => {
    if (request.status >= 200 && request.status < 300) {
      onDone(request.response as ArrayBuffer);
    } else {
      onError(new Error(`EPG request failed: HTTP ${request.status}`));
    }
  };
  request.onerror = () => onError(new Error("EPG request failed: network error"));
  request.onprogress = (event: ProgressEvent) => {
    post({ type: "progress", bytes: event.loaded, programmes: 0 });
  };
  request.send();
}

function fail(error: unknown): void {
  post({ type: "error", message: error instanceof Error ? error.message : String(error) });
}

function post(message: EpgResponse): void {
  (self as unknown as { postMessage: (m: EpgResponse) => void }).postMessage(message);
}
