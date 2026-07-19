/**
 * Content-based format detection.
 *
 * The sample provider serves an *IPTV M3U* from a URL ending in `.m3u8`, with
 * `Content-Type: audio/mpegurl` and `Content-Disposition: filename=playlist.m3u`
 * — three signals that disagree with each other. Extension and MIME type are
 * therefore hints at best; only the bytes are authoritative.
 *
 * Detection runs on a prefix, so a caller can classify a response before
 * committing to downloading all of it.
 */

export type PlaylistFormat =
  /** IPTV channel list: #EXTINF entries carrying tvg-id / group-title metadata. */
  | "extended-m3u"
  /** HLS master: #EXT-X-STREAM-INF variant list. */
  | "hls-master"
  /** HLS media: #EXT-X-TARGETDURATION segment list. */
  | "hls-media"
  /** Bare URL list, no #EXTM3U header. */
  | "simple-m3u"
  /** XMLTV EPG handed to us by mistake — a common user error worth naming. */
  | "xmltv"
  /** JSON (e.g. an Xtream API response, or an error envelope). */
  | "json"
  /** An HTML page — nearly always a login wall, captive portal or error. */
  | "html"
  | "unknown";

export interface DetectionResult {
  readonly format: PlaylistFormat;
  /** 0..1. Low confidence still yields a best guess rather than a failure. */
  readonly confidence: number;
  readonly reason: string;
  /** True when a byte-order mark was found and stripped. */
  readonly hadBom: boolean;
}

/** Strip a UTF-8 BOM. UTF-16 is handled at the decode layer, not here. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Decode bytes to text, honouring a BOM. webOS's TextDecoder handles the
 * legacy encodings we care about; we only need to pick the right label.
 */
export function decodePlaylistBytes(bytes: Uint8Array): string {
  const b0 = bytes[0];
  const b1 = bytes[1];
  const b2 = bytes[2];

  if (b0 === 0xff && b1 === 0xfe) return decodeWith(bytes, "utf-16le", 2);
  if (b0 === 0xfe && b1 === 0xff) return decodeWith(bytes, "utf-16be", 2);
  if (b0 === 0xef && b1 === 0xbb && b2 === 0xbf) return decodeWith(bytes, "utf-8", 3);

  // No BOM. UTF-8 is overwhelmingly the norm; `fatal: false` means a
  // mislabelled legacy-encoded playlist degrades to replacement characters in
  // a few names rather than failing the whole load.
  return decodeWith(bytes, "utf-8", 0);
}

function decodeWith(bytes: Uint8Array, label: string, skip: number): string {
  const view = bytes.subarray(skip);
  return new TextDecoder(label, { fatal: false }).decode(view);
}

const SAMPLE_CHARS = 64 * 1024;

export function detectFormat(input: string): DetectionResult {
  const hadBom = input.charCodeAt(0) === 0xfeff;
  const sample = stripBom(input).slice(0, SAMPLE_CHARS);
  const trimmed = sample.replace(/^\s+/, "");

  if (trimmed.length === 0) {
    return { format: "unknown", confidence: 1, reason: "empty document", hadBom };
  }

  // --- Non-M3U documents, checked first so we give a useful error instead of
  // --- "0 channels found".
  if (/^<\?xml/i.test(trimmed) || /^<!DOCTYPE\s+tv\b/i.test(trimmed) || /^<tv\b/i.test(trimmed)) {
    if (/<tv\b|<programme\b|<channel\b/i.test(trimmed)) {
      return { format: "xmltv", confidence: 0.95, reason: "XMLTV <tv>/<programme> markup", hadBom };
    }
  }
  if (/^<(!DOCTYPE\s+html|html|head|body)\b/i.test(trimmed)) {
    return { format: "html", confidence: 0.95, reason: "HTML document (login wall or error page?)", hadBom };
  }
  if (trimmed.charCodeAt(0) === 0x7b /* { */ || trimmed.charCodeAt(0) === 0x5b /* [ */) {
    return { format: "json", confidence: 0.8, reason: "JSON document", hadBom };
  }

  // --- M3U family. Order matters: HLS markers are more specific than #EXTINF,
  // --- and an HLS media playlist also contains #EXTINF lines.
  if (/^#EXT-X-STREAM-INF:/m.test(sample)) {
    return { format: "hls-master", confidence: 0.98, reason: "#EXT-X-STREAM-INF variant list", hadBom };
  }
  if (/^#EXT-X-(TARGETDURATION|MEDIA-SEQUENCE|ENDLIST|PLAYLIST-TYPE):/m.test(sample)) {
    return { format: "hls-media", confidence: 0.98, reason: "#EXT-X-* segment playlist tags", hadBom };
  }

  const hasExtM3u = /^#EXTM3U\b/m.test(sample);
  const hasExtInf = /^#EXTINF:/m.test(sample);

  if (hasExtInf) {
    // IPTV playlists carry channel metadata; plain media playlists do not.
    const iptvMarkers =
      /^#EXTGRP:/m.test(sample) ||
      /\b(tvg-id|tvg-name|tvg-logo|tvg-chno|group-title|catchup|url-tvg|x-tvg-url)\s*=/i.test(sample);
    if (iptvMarkers) {
      return { format: "extended-m3u", confidence: 0.97, reason: "#EXTINF with IPTV metadata attributes", hadBom };
    }
    // #EXTINF but no metadata at all: still an extended M3U, just a bare one.
    return { format: "extended-m3u", confidence: 0.6, reason: "#EXTINF entries without IPTV attributes", hadBom };
  }

  if (hasExtM3u) {
    return { format: "simple-m3u", confidence: 0.7, reason: "#EXTM3U header with no #EXTINF entries", hadBom };
  }

  // No directives at all — if most non-blank lines look like URLs, treat it as
  // a bare URL list.
  const lines = sample.split(/\r\n|\n|\r/).filter((l) => l.trim().length > 0);
  if (lines.length > 0) {
    const urlish = lines.filter((l) => /^[a-z][a-z0-9+.-]*:\/\//i.test(l.trim())).length;
    if (urlish / lines.length >= 0.8) {
      return { format: "simple-m3u", confidence: 0.75, reason: "bare list of URLs", hadBom };
    }
  }

  return { format: "unknown", confidence: 0.2, reason: "no recognisable playlist markers", hadBom };
}
