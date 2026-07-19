/**
 * Streaming XMLTV parser.
 *
 * The sample provider's EPG is **286 MB uncompressed / 683,311 programmes**.
 * A DOM parse would need multiple gigabytes of heap; on a TV with ~1–1.5 GB
 * shared with the OS that is not a slow path, it is a crash. So:
 *
 *  - Text arrives in chunks and is scanned with `indexOf`, never a DOM and
 *    never a regex over the whole document.
 *  - Only one element is materialised at a time.
 *  - The consumed prefix is compacted away, so the buffer stays proportional to
 *    the largest single element (a few hundred bytes), not to the file.
 *  - `channelFilter` rejects unwanted channels *before* any string allocation
 *    for the element body. On this provider that discards 980 of 1,277 channels
 *    — roughly 77% of the work — before it costs anything.
 *
 * This is a scanner, not a conforming XML parser. XMLTV is machine-generated
 * and extremely regular; the payoff for exploiting that is the difference
 * between "works on a TV" and "doesn't".
 */

import { parseXmltvTime } from "./time.ts";

export interface XmltvChannel {
  readonly id: string;
  readonly displayName: string;
  readonly icon?: string;
}

export interface XmltvProgramme {
  readonly channelId: string;
  /** Epoch seconds. */
  readonly start: number;
  /** Epoch seconds. */
  readonly stop: number;
  readonly title: string;
  readonly description?: string;
  readonly category?: string;
  readonly icon?: string;
}

export interface XmltvHandlers {
  onChannel?: (channel: XmltvChannel) => void;
  onProgramme?: (programme: XmltvProgramme) => void;
}

export interface XmltvParserOptions extends XmltvHandlers {
  /**
   * When present, only these channel ids are emitted. This is the single
   * biggest performance lever — pass the ids your playlists actually use.
   */
  channelFilter?: ReadonlySet<string>;
  /** Offset for timestamps that carry none of their own. */
  defaultOffsetMinutes?: number;
}

export interface XmltvStats {
  channelsSeen: number;
  channelsKept: number;
  programmesSeen: number;
  programmesKept: number;
  /** Elements that could not be parsed. Non-fatal; the scan continues. */
  malformed: number;
}

/** Compact once the consumed prefix exceeds this, to bound copying cost. */
const COMPACT_THRESHOLD = 1 << 20; // 1 MB

export class XmltvStreamParser {
  private buffer = "";
  private consumed = 0;
  private readonly options: XmltvParserOptions;

  readonly stats: XmltvStats = {
    channelsSeen: 0,
    channelsKept: 0,
    programmesSeen: 0,
    programmesKept: 0,
    malformed: 0,
  };

  constructor(options: XmltvParserOptions = {}) {
    this.options = options;
  }

  /** Feed a chunk of decoded text. Elements may span chunk boundaries. */
  write(text: string): void {
    this.buffer += text;
    this.drain(false);
  }

  /** Signal end of input and flush any final complete element. */
  end(): void {
    this.drain(true);
    this.buffer = "";
    this.consumed = 0;
  }

  private drain(final: boolean): void {
    for (;;) {
      const next = this.findNextElement();
      if (!next) break;

      const closeIndex = this.buffer.indexOf(next.closeTag, next.contentStart);
      if (closeIndex === -1) {
        if (!final) return; // wait for more input
        this.stats.malformed++;
        this.consumed = this.buffer.length;
        break;
      }

      // Only the open tag is materialised here. The body is passed as a range
      // and sliced by the handler *after* the channel filter has run — on this
      // provider that avoids ~522k body allocations, which is the difference
      // between a laptop-sized and a TV-sized heap.
      const openTag = this.buffer.slice(next.tagStart, next.contentStart);
      this.handleElement(next.kind, openTag, next.contentStart, closeIndex);
      this.consumed = closeIndex + next.closeTag.length;

      if (this.consumed > COMPACT_THRESHOLD) this.compact();
    }
    if (this.consumed > 0) this.compact();
  }

  private compact(): void {
    this.buffer = this.buffer.slice(this.consumed);
    this.consumed = 0;
  }

  private findNextElement():
    | { kind: "channel" | "programme"; tagStart: number; contentStart: number; closeTag: string; selfClosing: boolean }
    | null {
    const programmeIndex = this.buffer.indexOf("<programme", this.consumed);
    const channelIndex = this.buffer.indexOf("<channel", this.consumed);

    let kind: "channel" | "programme";
    let tagStart: number;
    if (programmeIndex === -1 && channelIndex === -1) {
      // Nothing pending: everything up to here is consumable.
      this.consumed = Math.max(this.consumed, this.buffer.length - 16);
      return null;
    }
    if (channelIndex === -1 || (programmeIndex !== -1 && programmeIndex < channelIndex)) {
      kind = "programme";
      tagStart = programmeIndex;
    } else {
      kind = "channel";
      tagStart = channelIndex;
    }

    const tagEnd = this.buffer.indexOf(">", tagStart);
    if (tagEnd === -1) return null; // open tag is split across chunks

    const selfClosing = this.buffer.charCodeAt(tagEnd - 1) === 47; /* / */
    if (selfClosing) {
      // `<channel id="x"/>` — no body, no closing tag. An empty range keeps the
      // handler signature uniform.
      const openTag = this.buffer.slice(tagStart, tagEnd);
      this.handleElement(kind, openTag, tagEnd, tagEnd);
      this.consumed = tagEnd + 1;
      if (this.consumed > COMPACT_THRESHOLD) this.compact();
      return this.findNextElement();
    }

    return {
      kind,
      tagStart,
      contentStart: tagEnd + 1,
      closeTag: kind === "programme" ? "</programme>" : "</channel>",
      selfClosing: false,
    };
  }

  private handleElement(
    kind: "channel" | "programme",
    openTag: string,
    bodyStart: number,
    bodyEnd: number,
  ): void {
    if (kind === "programme") this.handleProgramme(openTag, bodyStart, bodyEnd);
    else this.handleChannel(openTag, bodyStart, bodyEnd);
  }

  private handleProgramme(openTag: string, bodyStart: number, bodyEnd: number): void {
    this.stats.programmesSeen++;
    const onProgramme = this.options.onProgramme;
    if (!onProgramme) return;

    const channelId = attr(openTag, "channel");
    if (!channelId) {
      this.stats.malformed++;
      return;
    }
    // Reject before doing any body work — this is the 77% saving.
    if (this.options.channelFilter && !this.options.channelFilter.has(channelId)) return;

    const startRaw = attr(openTag, "start");
    if (!startRaw) {
      this.stats.malformed++;
      return;
    }
    const offset = this.options.defaultOffsetMinutes ?? 0;
    const start = parseXmltvTime(startRaw, offset);
    if (Number.isNaN(start)) {
      this.stats.malformed++;
      return;
    }

    const stopRaw = attr(openTag, "stop");
    const stop = stopRaw ? parseXmltvTime(stopRaw, offset) : Number.NaN;

    // Past the filter and past the cheap validity checks — only now is the
    // body worth materialising.
    const body = this.buffer.slice(bodyStart, bodyEnd);

    const title = decodeEntities(innerText(body, "title"));
    const description = innerText(body, "desc");
    const category = innerText(body, "category");
    const icon = attrOfTag(body, "icon", "src");

    const programme: {
      channelId: string;
      start: number;
      stop: number;
      title: string;
      description?: string;
      category?: string;
      icon?: string;
    } = {
      channelId,
      start,
      // A missing or broken stop is common at the tail of a guide. Assume
      // 30 minutes rather than dropping the programme.
      stop: Number.isNaN(stop) || stop <= start ? start + 1800 : stop,
      title: title || "(no title)",
    };
    if (description) programme.description = decodeEntities(description);
    if (category) programme.category = decodeEntities(category);
    if (icon) programme.icon = icon;

    this.stats.programmesKept++;
    onProgramme(programme);
  }

  private handleChannel(openTag: string, bodyStart: number, bodyEnd: number): void {
    this.stats.channelsSeen++;
    const onChannel = this.options.onChannel;
    if (!onChannel) return;

    const id = attr(openTag, "id");
    if (!id) {
      this.stats.malformed++;
      return;
    }
    if (this.options.channelFilter && !this.options.channelFilter.has(id)) return;

    const body = this.buffer.slice(bodyStart, bodyEnd);
    const channel: { id: string; displayName: string; icon?: string } = {
      id,
      displayName: decodeEntities(innerText(body, "display-name")) || id,
    };
    const icon = attrOfTag(body, "icon", "src");
    if (icon) channel.icon = icon;

    this.stats.channelsKept++;
    onChannel(channel);
  }
}

// --------------------------------------------------------------------------
// Element helpers. XMLTV attributes are always double-quoted in practice, but
// single quotes are accepted because a few generators emit them.

function attr(openTag: string, name: string): string | undefined {
  const key = name + "=";
  let from = 0;
  for (;;) {
    const index = openTag.indexOf(key, from);
    if (index === -1) return undefined;
    // Guard against matching a suffix of another attribute name.
    const before = index === 0 ? " " : openTag[index - 1];
    if (before !== " " && before !== "\t" && before !== "\n") {
      from = index + key.length;
      continue;
    }
    const quote = openTag[index + key.length];
    if (quote !== '"' && quote !== "'") {
      from = index + key.length;
      continue;
    }
    const valueStart = index + key.length + 1;
    const end = openTag.indexOf(quote, valueStart);
    if (end === -1) return undefined;
    return decodeEntities(openTag.slice(valueStart, end));
  }
}

/** Text content of the first `<tag ...>...</tag>` inside `body`. */
function innerText(body: string, tag: string): string {
  const open = body.indexOf("<" + tag);
  if (open === -1) return "";
  const contentStart = body.indexOf(">", open);
  if (contentStart === -1) return "";
  if (body.charCodeAt(contentStart - 1) === 47) return ""; // self-closing
  const close = body.indexOf("</" + tag + ">", contentStart);
  if (close === -1) return "";
  return body.slice(contentStart + 1, close).trim();
}

function attrOfTag(body: string, tag: string, attribute: string): string | undefined {
  const open = body.indexOf("<" + tag);
  if (open === -1) return undefined;
  const end = body.indexOf(">", open);
  if (end === -1) return undefined;
  return attr(body.slice(open, end), attribute);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * Decode XML entities. Skipped entirely when the text contains no '&', which
 * is the overwhelming majority of titles — worth checking given how many times
 * this runs.
 */
export function decodeEntities(text: string): string {
  if (text.indexOf("&") === -1) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, entity: string) => {
    if (entity.charCodeAt(0) === 35 /* # */) {
      const code =
        entity[1] === "x" || entity[1] === "X"
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? whole;
  });
}
