/**
 * Domain model for IPTV playlists.
 *
 * Deliberately provider-agnostic: fields that only some providers emit are
 * optional, and anything we do not recognise is preserved verbatim in
 * `attributes` / `vlcOptions` rather than discarded. Dropping unknown metadata
 * is the single most common reason competing apps "don't display all playlist
 * information" — we keep everything and let the UI decide.
 */

export type MediaKind = "live" | "vod" | "series" | "radio";

/** How a provider exposes its catchup/archive window. */
export type CatchupType =
  | "default" // append ?utc=&lutc= (Flussonic-style)
  | "shift" // same query params; the sample provider uses this
  | "append" // append catchup-source verbatim to the stream URL
  | "flussonic" // /timeshift_abs-{start}.m3u8
  | "xtream" // /timeshift/{user}/{pass}/{dur}/{Y-m-d:H-i}/{id}.ts
  | "vod";

export interface CatchupInfo {
  readonly type: CatchupType;
  /** Days of archive available. 0 / absent means no catchup. */
  readonly days: number;
  /** Explicit template from `catchup-source`, if the provider gave one. */
  readonly source?: string;
}

export interface Channel {
  /**
   * Stable identity for favourites, ordering and EPG binding. Derived from
   * tvg-id when present, else a hash of name+url. Must survive a playlist
   * refresh that reorders channels — index-based ids are why favourites get
   * scrambled in other apps.
   */
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly kind: MediaKind;

  /** XMLTV binding key. Empty string when the provider omitted it. */
  readonly tvgId: string;
  readonly tvgName?: string;
  readonly logo?: string;
  /** LCN / channel number, when the provider supplies one. */
  readonly channelNumber?: number;
  /** EPG time shift in hours (tvg-shift), can be fractional and negative. */
  readonly tvgShift?: number;

  readonly groups: readonly string[];
  readonly catchup?: CatchupInfo;

  /** Per-channel playback headers from #EXTVLCOPT / #EXTHTTP. */
  readonly userAgent?: string;
  readonly referrer?: string;
  readonly httpHeaders?: Readonly<Record<string, string>>;

  /** Nominal duration from #EXTINF. <= 0 means "live / unknown". */
  readonly duration: number;

  /** Every attribute seen on #EXTINF, unmodified, including unknown keys. */
  readonly attributes: Readonly<Record<string, string>>;

  /** 1-based line number in the source, for diagnostics. */
  readonly line: number;
}

export interface PlaylistHeader {
  /** url-tvg / x-tvg-url / tvg-url — may list several, comma-separated. */
  readonly epgUrls: readonly string[];
  /** max-conn: hard cap on concurrent streams. Honour it. */
  readonly maxConnections?: number;
  readonly catchupType?: CatchupType;
  readonly name?: string;
  readonly attributes: Readonly<Record<string, string>>;
}

export type ParseIssueLevel = "warning" | "error";

export interface ParseIssue {
  readonly level: ParseIssueLevel;
  readonly code: string;
  readonly message: string;
  readonly line: number;
}

export interface Playlist {
  readonly header: PlaylistHeader;
  readonly channels: readonly Channel[];
  readonly groups: readonly string[];
  /**
   * Non-fatal problems. A playlist always parses to *something*; malformed
   * entries are reported here and skipped rather than aborting the load.
   */
  readonly issues: readonly ParseIssue[];
}
