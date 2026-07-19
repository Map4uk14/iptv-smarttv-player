/**
 * Catchup / archive URL derivation.
 *
 * Verified against the sample provider (Flussonic, `catchup-type="shift"`) on
 * 2026-07-19 by requesting a timestamp two hours in the past:
 *
 *   ?utc=&lutc=              -> served 07:45:14Z  (the requested time)  CORRECT
 *   /timeshift_abs-{start}   -> served 09:44:59Z  (the live edge)       WRONG
 *   /index-{start}-{dur}     -> served 09:44:59Z  (the live edge)       WRONG
 *
 * All three returned HTTP 200. The two wrong forms silently fall back to live,
 * which is why `verifyCatchupResponse` exists: for catchup, a 2xx is not a
 * success signal — only the returned PROGRAM-DATE-TIME is.
 */

import type { CatchupInfo, Channel } from "../playlist/types.ts";

export interface CatchupRequest {
  readonly channel: Channel;
  /** Programme start, epoch seconds, UTC. */
  readonly startSeconds: number;
  /** Programme duration in seconds; used by templates that need an end. */
  readonly durationSeconds: number;
  /** Current wall clock, epoch seconds. Injected for testability. */
  readonly nowSeconds: number;
}

export type CatchupUnavailableReason = "no-archive" | "outside-window" | "in-future";

export class CatchupUnavailableError extends Error {
  readonly reason: CatchupUnavailableReason;

  constructor(message: string, reason: CatchupUnavailableReason) {
    super(message);
    this.name = "CatchupUnavailableError";
    this.reason = reason;
  }
}

/**
 * Whether `startSeconds` falls inside the channel's advertised archive window.
 * Checked before building a URL so the UI can grey out unreachable programmes
 * instead of handing the user a stream that silently plays live TV.
 */
export function isWithinArchive(catchup: CatchupInfo | undefined, startSeconds: number, nowSeconds: number): boolean {
  if (!catchup || catchup.days <= 0) return false;
  if (startSeconds >= nowSeconds) return false;
  return startSeconds >= nowSeconds - catchup.days * 86400;
}

export interface ArchiveRange {
  /** Oldest reachable moment, epoch seconds. */
  readonly start: number;
  /** Live edge, epoch seconds. */
  readonly end: number;
}

/**
 * The seekable window for a channel, or null when it has no archive.
 *
 * This is what a scrub bar spans. Deriving it from the advertised
 * `catchup-days` rather than from the EPG matters: the guide may hold 22 days
 * of listings while only 7 days are actually retrievable, and letting the user
 * scrub into the other 15 would produce a stream that plays the wrong content.
 */
export function archiveRange(
  catchup: CatchupInfo | undefined,
  nowSeconds: number,
): ArchiveRange | null {
  if (!catchup || catchup.days <= 0) return null;
  return { start: nowSeconds - catchup.days * 86400, end: nowSeconds };
}

/**
 * Margin held back from the live edge when seeking.
 *
 * Seeking too close to "now" returns a manifest with almost nothing in it —
 * the server has not finished writing those segments yet. Measured against the
 * reference provider (5-second segments), by how many segments came back:
 *
 *   10s behind live -> 1 segment   (~5s of video: stalls immediately)
 *   20s behind live -> 3 segments
 *   40s behind live -> 4 segments
 *  120s behind live -> 4 segments
 *
 * Every one of those honoured the requested time exactly (0s drift), so this
 * is purely about starting with enough buffer to play smoothly. 30s sits above
 * the point where the window stops being starved.
 *
 * Callers wanting the live edge should switch to the live URL, not seek near it.
 */
export const LIVE_EDGE_MARGIN_SECONDS = 30;

export function clampToArchive(
  catchup: CatchupInfo | undefined,
  requestedSeconds: number,
  nowSeconds: number,
): number | null {
  const range = archiveRange(catchup, nowSeconds);
  if (!range) return null;
  const latest = range.end - LIVE_EDGE_MARGIN_SECONDS;
  if (requestedSeconds >= latest) return latest;
  if (requestedSeconds < range.start) return range.start;
  return requestedSeconds;
}

export function buildCatchupUrl(req: CatchupRequest): string {
  const { channel, startSeconds, durationSeconds, nowSeconds } = req;
  const catchup = channel.catchup;

  if (!catchup) {
    throw new CatchupUnavailableError(`"${channel.name}" has no archive`, "no-archive");
  }
  if (startSeconds >= nowSeconds) {
    throw new CatchupUnavailableError("cannot play a programme that has not aired", "in-future");
  }
  if (!isWithinArchive(catchup, startSeconds, nowSeconds)) {
    throw new CatchupUnavailableError(
      `programme is older than the ${catchup.days}-day archive`,
      "outside-window",
    );
  }

  // An explicit provider template always wins over our conventions.
  if (catchup.source && catchup.source.length > 0) {
    return expandTemplate(catchup.source, channel, startSeconds, durationSeconds, nowSeconds);
  }

  switch (catchup.type) {
    case "shift":
    case "default":
      return appendQuery(channel.url, { utc: startSeconds, lutc: nowSeconds });

    case "append":
      return channel.url + expandTemplate(catchup.source ?? "", channel, startSeconds, durationSeconds, nowSeconds);

    case "flussonic":
      return flussonicUrl(channel.url, startSeconds, durationSeconds);

    case "xtream":
      return xtreamUrl(channel.url, startSeconds, durationSeconds);

    case "vod":
      return channel.url;
  }
}

function appendQuery(url: string, params: Record<string, number>): string {
  const separator = url.includes("?") ? "&" : "?";
  const query = Object.entries(params)
    .map(([k, v]) => `${k}=${Math.floor(v)}`)
    .join("&");
  return `${url}${separator}${query}`;
}

/**
 * Flussonic archive path form. Replaces the trailing manifest/segment name:
 *   /ch/video.m3u8 -> /ch/timeshift_abs-{start}.m3u8
 *
 * Note this form did *not* work on the sample provider despite it being a
 * Flussonic server — it is retained for providers that do honour it, and is
 * never chosen unless the playlist explicitly asks for it.
 */
function flussonicUrl(url: string, startSeconds: number, durationSeconds: number): string {
  const [base = url, query] = url.split("?", 2);
  const extension = /\.m3u8?$/i.test(base) ? ".m3u8" : ".ts";
  const replaced = base.replace(
    /\/[^/]*$/,
    extension === ".m3u8"
      ? `/timeshift_abs-${Math.floor(startSeconds)}.m3u8`
      : `/archive-${Math.floor(startSeconds)}-${Math.floor(durationSeconds)}.ts`,
  );
  return query ? `${replaced}?${query}` : replaced;
}

/** Xtream Codes: /timeshift/{user}/{pass}/{durationMinutes}/{Y-m-d:H-i}/{id}.ts */
function xtreamUrl(url: string, startSeconds: number, durationSeconds: number): string {
  const match = /^(https?:\/\/[^/]+)\/(?:live\/)?([^/]+)\/([^/]+)\/(\d+)(?:\.\w+)?$/i.exec(url);
  if (!match) return appendQuery(url, { utc: startSeconds, lutc: Math.floor(Date.now() / 1000) });
  const [, origin, user, pass, id] = match;
  const minutes = Math.max(1, Math.round(durationSeconds / 60));
  return `${origin}/timeshift/${user}/${pass}/${minutes}/${formatXtreamTime(startSeconds)}/${id}.ts`;
}

function formatXtreamTime(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}:${p(d.getUTCHours())}-${p(d.getUTCMinutes())}`;
}

/**
 * Expand a `catchup-source` template. Supports the placeholder vocabulary used
 * across the common IPTV tools; unknown placeholders are left intact so a
 * partially-understood template still produces a usable URL.
 */
function expandTemplate(
  template: string,
  channel: Channel,
  startSeconds: number,
  durationSeconds: number,
  nowSeconds: number,
): string {
  const end = startSeconds + durationSeconds;
  const start = Math.floor(startSeconds);

  return template
    .replace(/\$\{?start\}?|\{utc\}|\$\{?timestamp\}?/gi, String(start))
    .replace(/\{utcend\}|\$\{?end\}?/gi, String(Math.floor(end)))
    .replace(/\{lutc\}|\$\{?now\}?/gi, String(Math.floor(nowSeconds)))
    .replace(/\{duration\}|\$\{?offset\}?/gi, String(Math.floor(durationSeconds)))
    .replace(/\{durmin\}/gi, String(Math.max(1, Math.round(durationSeconds / 60))))
    .replace(/\{channel\}/gi, channel.tvgId || channel.id)
    .replace(/\{(Y|Y-m-d|Y-m-d:H-i|H|M|d|m)\}/g, (_m, token: string) => strftime(token, start))
    .replace(/\$\{?(\w+)\}?/g, (whole: string) => whole);
}

function strftime(token: string, epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const p = (n: number): string => String(n).padStart(2, "0");
  switch (token) {
    case "Y":
      return String(d.getUTCFullYear());
    case "m":
      return p(d.getUTCMonth() + 1);
    case "d":
      return p(d.getUTCDate());
    case "H":
      return p(d.getUTCHours());
    case "M":
      return p(d.getUTCMinutes());
    case "Y-m-d":
      return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
    case "Y-m-d:H-i":
      return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}:${p(d.getUTCHours())}-${p(d.getUTCMinutes())}`;
    default:
      return token;
  }
}

/**
 * Confirm a catchup manifest actually seeked.
 *
 * The sample provider returns 200 with live content for unsupported archive
 * forms, so this compares the manifest's EXT-X-PROGRAM-DATE-TIME against the
 * requested start. Used to validate a provider's catchup convention once, at
 * playlist-add time, rather than surprising the user mid-programme.
 *
 * Note: webOS does not expose PROGRAM-DATE-TIME to the app at playback time,
 * so this runs over a manifest we fetched ourselves, not via the player.
 */
export function verifyCatchupResponse(
  manifest: string,
  requestedStartSeconds: number,
  toleranceSeconds = 300,
): { ok: boolean; actualStartSeconds?: number; reason: string } {
  const match = /^#EXT-X-PROGRAM-DATE-TIME:(.+)$/m.exec(manifest);
  if (!match || !match[1]) {
    return { ok: false, reason: "manifest has no EXT-X-PROGRAM-DATE-TIME to verify against" };
  }
  const actual = Date.parse(match[1].trim());
  if (Number.isNaN(actual)) {
    return { ok: false, reason: `unparseable PROGRAM-DATE-TIME: ${match[1].trim()}` };
  }
  const actualSeconds = Math.floor(actual / 1000);
  const drift = Math.abs(actualSeconds - requestedStartSeconds);
  if (drift <= toleranceSeconds) {
    return { ok: true, actualStartSeconds: actualSeconds, reason: `seeked to within ${drift}s of the request` };
  }
  return {
    ok: false,
    actualStartSeconds: actualSeconds,
    reason: `server ignored the seek: off by ${drift}s (likely served the live edge)`,
  };
}
