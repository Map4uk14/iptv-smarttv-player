/**
 * Attribute tokenizer for #EXTINF / #EXTM3U lines.
 *
 * There is no real specification for IPTV attributes — the format is whatever
 * the dominant tools happen to accept. Observed variation in the wild that this
 * handles:
 *
 *   tvg-id="cnn"                 canonical
 *   tvg-id='cnn'                 single quotes
 *   tvg-id=cnn                   unquoted, terminated by whitespace
 *   tvg-id = "cnn"               spaces around '='
 *   group-title="News, Live"     comma inside a quoted value  <-- the classic bug
 *   tvg-logo="http://a/b?x=1"    '=' inside a quoted value
 *   TVG-ID="cnn"                 mixed case keys
 *
 * Keys are lower-cased; values are kept verbatim. Unknown keys are returned
 * like any other, so callers can preserve provider extensions.
 */

export interface AttributeScan {
  readonly attributes: Record<string, string>;
  /** Index just past the last attribute consumed. */
  readonly end: number;
}

const Ch = {
  Tab: 9,
  LF: 10,
  CR: 13,
  Space: 32,
  Quote: 34,
  Apos: 39,
  Comma: 44,
  Equals: 61,
} as const;

function isSpace(code: number): boolean {
  return code === Ch.Space || code === Ch.Tab || code === Ch.CR || code === Ch.LF;
}

/**
 * Scan `key=value` pairs starting at `start`.
 *
 * Stops at the first unquoted comma (the EXTINF title separator) or end of
 * input. Text that is not a well-formed pair is skipped without aborting the
 * scan — a single malformed attribute must not cost us the whole channel.
 */
export function scanAttributes(line: string, start = 0): AttributeScan {
  const attributes: Record<string, string> = {};
  const len = line.length;
  let i = start;

  while (i < len) {
    const code = line.charCodeAt(i);

    if (isSpace(code)) {
      i++;
      continue;
    }
    // Unquoted comma ends the attribute region (title follows on #EXTINF).
    if (code === Ch.Comma) break;

    // --- key
    const keyStart = i;
    while (i < len) {
      const c = line.charCodeAt(i);
      if (c === Ch.Equals || c === Ch.Comma || isSpace(c)) break;
      i++;
    }
    const rawKey = line.slice(keyStart, i);

    // Allow spaces between key and '='.
    let j = i;
    while (j < len && isSpace(line.charCodeAt(j))) j++;

    if (j >= len || line.charCodeAt(j) !== Ch.Equals) {
      // Bare token with no '='. Not an attribute; skip it and continue so the
      // rest of the line still parses.
      if (rawKey.length === 0) i++;
      continue;
    }

    i = j + 1; // past '='
    while (i < len && isSpace(line.charCodeAt(i))) i++;

    // --- value
    let value: string;
    const q = i < len ? line.charCodeAt(i) : -1;
    if (q === Ch.Quote || q === Ch.Apos) {
      const valueStart = ++i;
      while (i < len && line.charCodeAt(i) !== q) i++;
      value = line.slice(valueStart, i);
      if (i < len) i++; // past closing quote
      // Unterminated quote: we consumed to end of line, which is the most
      // useful recovery — the value was almost certainly meant to run on.
    } else {
      const valueStart = i;
      while (i < len) {
        const c = line.charCodeAt(i);
        if (isSpace(c) || c === Ch.Comma) break;
        i++;
      }
      value = line.slice(valueStart, i);
    }

    if (rawKey.length > 0) {
      attributes[rawKey.toLowerCase()] = value;
    }
  }

  return { attributes, end: i };
}

export interface ExtInfLine {
  readonly duration: number;
  readonly attributes: Record<string, string>;
  readonly title: string;
}

/**
 * Parse the body of an `#EXTINF:` line (everything after the colon).
 *
 * Shape: `<duration>[ attributes],<title>`
 *
 * The title is everything after the first *unquoted* comma. Titles legitimately
 * contain commas ("Movie, The"), so the split is done by the tokenizer's quote
 * tracking rather than by `lastIndexOf(',')` or a naive `split(',')`.
 */
export function parseExtInf(body: string): ExtInfLine {
  const len = body.length;
  let i = 0;

  // --- duration: optional sign, digits, optional fraction.
  while (i < len && isSpace(body.charCodeAt(i))) i++;
  const numStart = i;
  if (i < len && (body[i] === "-" || body[i] === "+")) i++;
  while (i < len) {
    const c = body.charCodeAt(i);
    if ((c >= 48 && c <= 57) || c === 46 /* . */) i++;
    else break;
  }
  const rawDuration = body.slice(numStart, i);
  const parsed = Number.parseFloat(rawDuration);
  // Missing/garbage duration is common and harmless for live TV; -1 means
  // "unknown", consistent with the EXTINF convention.
  const duration = Number.isFinite(parsed) ? parsed : -1;

  const scan = scanAttributes(body, i);

  let title = "";
  if (scan.end < len && body.charCodeAt(scan.end) === Ch.Comma) {
    title = body.slice(scan.end + 1).trim();
  } else {
    // No comma at all. Some generators emit `#EXTINF:-1,Name` correctly but
    // others emit `#EXTINF:-1 Name`; recover the trailing text as the title.
    const rest = body.slice(scan.end).trim();
    if (rest.length > 0 && !rest.includes("=")) title = rest;
  }

  return { duration, attributes: scan.attributes, title };
}
