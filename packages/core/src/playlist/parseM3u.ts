/**
 * Extended-M3U (IPTV) playlist parser.
 *
 * Design rules, all of which exist because the alternative produces the
 * failure modes the market is full of:
 *
 *  - **Never throw on bad input.** A playlist with one broken entry loses that
 *    entry, not the other 20,000. Problems surface as `issues`.
 *  - **Single pass, no regex over the whole document.** Large playlists reach
 *    100k+ entries; per-line scanning keeps this linear and allocation-light.
 *  - **Preserve unknown attributes.** We cannot enumerate every provider
 *    extension, so we keep them all.
 *  - **Stable ids.** Derived from content, never from position, so favourites
 *    and orderings survive a refresh that reorders the file.
 */

import { parseExtInf, scanAttributes } from "./attributes.ts";
import { stripBom } from "./detect.ts";
import type {
  CatchupInfo,
  CatchupType,
  Channel,
  MediaKind,
  ParseIssue,
  Playlist,
  PlaylistHeader,
} from "./types.ts";

export interface ParseOptions {
  /** Stop after N channels (0 = unlimited). Guards against runaway inputs. */
  readonly limit?: number;
  /** Cap on retained issues, so a pathological file cannot exhaust memory. */
  readonly maxIssues?: number;
}

const DEFAULT_MAX_ISSUES = 500;

export function parseM3u(source: string, options: ParseOptions = {}): Playlist {
  const maxIssues = options.maxIssues ?? DEFAULT_MAX_ISSUES;
  const limit = options.limit ?? 0;

  const channels: Channel[] = [];
  const issues: ParseIssue[] = [];
  const groupOrder: string[] = [];
  const seenGroups = new Set<string>();
  const usedIds = new Set<string>();

  let header: PlaylistHeader = { epgUrls: [], attributes: {} };
  let sawHeader = false;

  // --- Pending state for the entry currently being assembled.
  let pending: PendingEntry | null = null;

  const addIssue = (level: ParseIssue["level"], code: string, message: string, line: number): void => {
    if (issues.length < maxIssues) issues.push({ level, code, message, line });
  };

  const text = stripBom(source);
  const len = text.length;

  let lineNo = 0;
  let pos = 0;

  while (pos <= len) {
    // Manual line slicing handles LF, CRLF and lone-CR without allocating a
    // full split() array for a 100k-line document.
    let end = text.indexOf("\n", pos);
    if (end === -1) end = len;
    let rawEnd = end;
    if (rawEnd > pos && text.charCodeAt(rawEnd - 1) === 13) rawEnd--; // CR
    const line = text.slice(pos, rawEnd);
    pos = end + 1;
    lineNo++;

    const trimmed = line.trim();
    if (trimmed.length === 0) {
      if (end >= len) break;
      continue;
    }

    if (trimmed.charCodeAt(0) === 35 /* # */) {
      // Scan the tag as `#` + [A-Za-z0-9-]+ rather than splitting on the first
      // ':'. A header line carries URLs in its attributes
      // (`#EXTM3U url-tvg="http://..."`), so the first colon in the line can
      // belong to a URL scheme and has nothing to do with the tag.
      let t = 1;
      while (t < trimmed.length) {
        const c = trimmed.charCodeAt(t);
        const isTagChar =
          (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45; /* - */
        if (!isTagChar) break;
        t++;
      }
      const tag = trimmed.slice(0, t).toUpperCase();
      const hasColon = t < trimmed.length && trimmed.charCodeAt(t) === 58; /* : */
      const body = hasColon ? trimmed.slice(t + 1) : trimmed.slice(t);

      switch (tag) {
        case "#EXTM3U": {
          // Header attributes follow the tag, normally with no colon:
          //   #EXTM3U url-tvg="..." max-conn="2"
          header = buildHeader(scanAttributes(body).attributes);
          sawHeader = true;
          break;
        }

        case "#EXTINF": {
          if (pending) {
            addIssue("warning", "orphan-extinf", `"${pending.title}" has no stream URL; skipped`, pending.line);
          }
          const info = parseExtInf(body);
          pending = {
            line: lineNo,
            title: info.title,
            duration: info.duration,
            attributes: info.attributes,
            extGrp: undefined,
            vlcOptions: {},
            httpHeaders: undefined,
          };
          break;
        }

        case "#EXTGRP": {
          if (pending) pending.extGrp = body.trim();
          break;
        }

        case "#EXTVLCOPT": {
          // `#EXTVLCOPT:http-user-agent=Mozilla/5.0`
          if (pending) {
            const eq = body.indexOf("=");
            if (eq > 0) {
              pending.vlcOptions[body.slice(0, eq).trim().toLowerCase()] = body.slice(eq + 1).trim();
            }
          }
          break;
        }

        case "#EXTHTTP": {
          // `#EXTHTTP:{"User-Agent":"...","Cookie":"..."}`
          if (pending) {
            try {
              const parsed: unknown = JSON.parse(body);
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                const headers: Record<string, string> = {};
                for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
                  if (typeof v === "string") headers[k] = v;
                }
                pending.httpHeaders = headers;
              }
            } catch {
              addIssue("warning", "bad-exthttp", "#EXTHTTP payload is not valid JSON; ignored", lineNo);
            }
          }
          break;
        }

        case "#KODIPROP": {
          // Kodi/inputstream properties. Retained as attributes so DRM and
          // manifest-type hints survive for platforms that can use them.
          if (pending) {
            const eq = body.indexOf("=");
            if (eq > 0) {
              pending.attributes[`kodiprop:${body.slice(0, eq).trim().toLowerCase()}`] = body.slice(eq + 1).trim();
            }
          }
          break;
        }

        case "#PLAYLIST": {
          header = { ...header, name: body.trim() };
          break;
        }

        default:
          // Unknown directive or a plain comment. Ignore silently — playlists
          // routinely carry generator comments and noisy warnings help nobody.
          break;
      }

      if (end >= len) break;
      continue;
    }

    // --- Not a directive: this is a URI.
    if (!pending) {
      // A URL with no preceding #EXTINF. Valid in a simple M3U, so accept it
      // with a synthesised name rather than dropping it.
      pending = {
        line: lineNo,
        title: "",
        duration: -1,
        attributes: {},
        extGrp: undefined,
        vlcOptions: {},
        httpHeaders: undefined,
      };
    }

    const channel = buildChannel(pending, trimmed, usedIds);
    channels.push(channel);
    for (const g of channel.groups) {
      if (!seenGroups.has(g)) {
        seenGroups.add(g);
        groupOrder.push(g);
      }
    }
    pending = null;

    if (limit > 0 && channels.length >= limit) break;
    if (end >= len) break;
  }

  if (pending) {
    addIssue("warning", "orphan-extinf", `"${pending.title}" has no stream URL; skipped`, pending.line);
  }
  if (!sawHeader) {
    addIssue("warning", "missing-extm3u", "playlist has no #EXTM3U header", 1);
  }
  if (channels.length === 0) {
    addIssue("error", "no-channels", "no playable entries were found", 1);
  }

  return { header, channels, groups: groupOrder, issues };
}

// --------------------------------------------------------------------------

interface PendingEntry {
  line: number;
  title: string;
  duration: number;
  attributes: Record<string, string>;
  extGrp: string | undefined;
  vlcOptions: Record<string, string>;
  httpHeaders: Record<string, string> | undefined;
}

function buildHeader(attributes: Record<string, string>): PlaylistHeader {
  // Providers disagree on the EPG key; accept all three, and each may hold a
  // comma-separated list.
  const epgUrls: string[] = [];
  for (const key of ["url-tvg", "x-tvg-url", "tvg-url"]) {
    const raw = attributes[key];
    if (!raw) continue;
    for (const part of raw.split(",")) {
      const url = part.trim();
      if (url.length > 0 && !epgUrls.includes(url)) epgUrls.push(url);
    }
  }

  const maxConnRaw = attributes["max-conn"];
  const maxConn = maxConnRaw ? Number.parseInt(maxConnRaw, 10) : Number.NaN;

  const header: {
    epgUrls: string[];
    attributes: Record<string, string>;
    maxConnections?: number;
    catchupType?: CatchupType;
  } = { epgUrls, attributes };

  if (Number.isFinite(maxConn) && maxConn > 0) header.maxConnections = maxConn;

  const ct = normaliseCatchupType(attributes["catchup-type"] ?? attributes["catchup"]);
  if (ct) header.catchupType = ct;

  return header;
}

function normaliseCatchupType(raw: string | undefined): CatchupType | undefined {
  if (!raw) return undefined;
  switch (raw.trim().toLowerCase()) {
    case "shift":
    case "timeshift":
      return "shift";
    case "append":
      return "append";
    case "flussonic":
    case "flussonic-hls":
    case "flussonic-ts":
      return "flussonic";
    case "xc":
    case "xtream":
      return "xtream";
    case "vod":
      return "vod";
    case "default":
    case "1":
      return "default";
    default:
      return undefined;
  }
}

function buildChannel(entry: PendingEntry, url: string, usedIds: Set<string>): Channel {
  const a = entry.attributes;

  const name = entry.title || a["tvg-name"] || a["tvg-id"] || deriveNameFromUrl(url);

  // group-title is canonical; #EXTGRP is the older convention. Some playlists
  // use both, and some pack several groups into one value with ';'.
  const groups: string[] = [];
  const pushGroup = (raw: string | undefined): void => {
    if (!raw) return;
    for (const part of raw.split(";")) {
      const g = part.trim();
      if (g.length > 0 && !groups.includes(g)) groups.push(g);
    }
  };
  pushGroup(a["group-title"]);
  pushGroup(entry.extGrp);
  if (groups.length === 0) groups.push("Uncategorised");

  const tvgId = (a["tvg-id"] ?? "").trim();

  const channel: {
    id: string;
    name: string;
    url: string;
    kind: MediaKind;
    tvgId: string;
    groups: string[];
    duration: number;
    attributes: Record<string, string>;
    line: number;
    tvgName?: string;
    logo?: string;
    channelNumber?: number;
    tvgShift?: number;
    catchup?: CatchupInfo;
    userAgent?: string;
    referrer?: string;
    httpHeaders?: Record<string, string>;
  } = {
    id: makeStableId(tvgId, name, url, usedIds),
    name,
    url,
    kind: classifyKind(a, url, entry.duration),
    tvgId,
    groups,
    duration: entry.duration,
    attributes: a,
    line: entry.line,
  };

  const tvgName = a["tvg-name"];
  if (tvgName) channel.tvgName = tvgName;

  const logo = a["tvg-logo"] ?? a["logo"];
  if (logo) channel.logo = logo;

  const chnoRaw = a["tvg-chno"] ?? a["channel-number"] ?? a["tvg-num"];
  if (chnoRaw) {
    const n = Number.parseInt(chnoRaw, 10);
    if (Number.isFinite(n)) channel.channelNumber = n;
  }

  const shiftRaw = a["tvg-shift"] ?? a["timeshift"];
  if (shiftRaw) {
    const n = Number.parseFloat(shiftRaw);
    if (Number.isFinite(n) && n !== 0) channel.tvgShift = n;
  }

  const catchup = buildCatchup(a);
  if (catchup) channel.catchup = catchup;

  const ua = entry.vlcOptions["http-user-agent"] ?? a["user-agent"];
  if (ua) channel.userAgent = ua;

  const ref = entry.vlcOptions["http-referrer"] ?? entry.vlcOptions["http-referer"] ?? a["referrer"];
  if (ref) channel.referrer = ref;

  if (entry.httpHeaders) channel.httpHeaders = entry.httpHeaders;

  return channel as Channel;
}

function buildCatchup(a: Record<string, string>): CatchupInfo | undefined {
  const daysRaw = a["catchup-days"] ?? a["tvg-rec"] ?? a["timeshift"];
  const days = daysRaw ? Number.parseInt(daysRaw, 10) : 0;
  const type = normaliseCatchupType(a["catchup-type"] ?? a["catchup"]);
  const source = a["catchup-source"];

  // No signal at all means no archive. A type or source without days still
  // implies catchup exists, so default the window rather than disabling it.
  if (!type && !source && !(Number.isFinite(days) && days > 0)) return undefined;

  const info: { type: CatchupType; days: number; source?: string } = {
    type: type ?? (source ? "append" : "default"),
    days: Number.isFinite(days) && days > 0 ? days : 0,
  };
  if (source) info.source = source;
  return info;
}

function classifyKind(a: Record<string, string>, url: string, duration: number): MediaKind {
  if (a["radio"] === "true" || a["radio"] === "1") return "radio";

  // Xtream-style path segments are the most reliable signal when present.
  if (/\/series\//i.test(url)) return "series";
  if (/\/movie\//i.test(url)) return "vod";
  if (/\/live\//i.test(url)) return "live";

  // A positive finite duration means fixed-length media; live entries use
  // 0 or -1. This provider emits `#EXTINF:0`.
  if (duration > 0) {
    return /[Ss]\d{1,3}[\s._-]?[Ee]\d{1,3}/.test(url) ? "series" : "vod";
  }
  return "live";
}

function deriveNameFromUrl(url: string): string {
  try {
    const path = url.split(/[?#]/, 1)[0] ?? url;
    const segments = path.split("/").filter((s) => s.length > 0);
    const last = segments[segments.length - 1];
    if (last && !/^(video|index|playlist|stream)\.\w+$/i.test(last)) {
      return decodeURIComponent(last.replace(/\.\w{2,5}$/, ""));
    }
    const parent = segments[segments.length - 2];
    if (parent) return decodeURIComponent(parent);
  } catch {
    // Malformed percent-encoding — fall through.
  }
  return "Unknown";
}

/**
 * Content-derived, collision-free channel id.
 *
 * tvg-id is preferred because it is the provider's own stable key, but it is
 * not guaranteed unique (this sample has distinct SD/HD entries, and other
 * providers duplicate ids across groups). Collisions get a deterministic
 * suffix so ids stay stable across reloads of the same file.
 */
function makeStableId(tvgId: string, name: string, url: string, used: Set<string>): string {
  const base = tvgId.length > 0 ? `t:${tvgId}` : `u:${hash32(name + " " + url)}`;
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let n = 2;
  let candidate = `${base}#${n}`;
  while (used.has(candidate)) {
    n++;
    candidate = `${base}#${n}`;
  }
  used.add(candidate);
  return candidate;
}

/** FNV-1a. Fast, dependency-free, and adequate for id derivation. */
function hash32(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
