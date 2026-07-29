/**
 * Incremental UTF-8 decoder.
 *
 * Needed because the EPG arrives as gzip and is inflated in chunks, so a single
 * character routinely straddles a chunk boundary — and the two obvious ways out
 * are both unavailable on the target TV:
 *
 *   TextDecoder({ stream: true })   not guaranteed on Chromium 38
 *   pako's `to: "string"`           removed in pako 2.0; pako 3 emits bytes only
 *
 * Decoding each chunk independently would corrupt every character unlucky
 * enough to span a boundary. On a Cyrillic feed, where nearly every character is
 * two bytes, that is roughly one corruption per chunk — few enough to look like
 * bad data from the provider rather than a bug here.
 *
 * Used only where TextDecoder is missing; both paths are covered by the tests,
 * which check this against TextDecoder at every possible split point.
 */

/** Batch size for String.fromCharCode.apply — large arrays overflow the stack. */
const FLUSH_AT = 4096;

const REPLACEMENT = 0xfffd;

export class Utf8StreamDecoder {
  /** Bytes of a sequence that ran off the end of the last chunk. */
  private readonly pending = new Uint8Array(4);
  private pendingLength = 0;
  /** Total length the pending sequence will be once complete. */
  private pendingNeeds = 0;

  /** Decode a chunk, holding back any trailing partial sequence. */
  decode(input: Uint8Array): string {
    const units: number[] = [];
    let out = "";
    let i = 0;

    // Finish the sequence left over from the previous chunk first.
    if (this.pendingLength > 0) {
      while (this.pendingLength < this.pendingNeeds && i < input.length) {
        this.pending[this.pendingLength++] = input[i++]!;
      }
      if (this.pendingLength < this.pendingNeeds) return ""; // still short
      emit(units, codePoint(this.pending, 0, this.pendingNeeds));
      this.pendingLength = 0;
      this.pendingNeeds = 0;
    }

    while (i < input.length) {
      const lead = input[i]!;
      const needs = sequenceLength(lead);

      if (i + needs > input.length) {
        // Truncated by the chunk boundary — keep the bytes for next time.
        this.pendingNeeds = needs;
        this.pendingLength = 0;
        while (i < input.length) this.pending[this.pendingLength++] = input[i++]!;
        break;
      }

      emit(units, codePoint(input, i, needs));
      i += needs;

      if (units.length >= FLUSH_AT) {
        out += String.fromCharCode.apply(null, units);
        units.length = 0;
      }
    }

    if (units.length > 0) out += String.fromCharCode.apply(null, units);
    return out;
  }

  /**
   * Flush a sequence still incomplete at end of input.
   *
   * Truncated input is malformed, so this yields the replacement character —
   * the same thing TextDecoder does with a non-streaming final call.
   */
  end(): string {
    if (this.pendingLength === 0) return "";
    this.pendingLength = 0;
    this.pendingNeeds = 0;
    return String.fromCharCode(REPLACEMENT);
  }
}

function sequenceLength(lead: number): number {
  if (lead < 0x80) return 1;
  if (lead < 0xc0) return 1; // stray continuation byte; consumed as an error
  if (lead < 0xe0) return 2;
  if (lead < 0xf0) return 3;
  if (lead < 0xf8) return 4;
  return 1;
}

function codePoint(bytes: Uint8Array, at: number, length: number): number {
  const lead = bytes[at]!;
  switch (length) {
    case 1:
      return lead < 0x80 ? lead : REPLACEMENT;
    case 2:
      return ((lead & 0x1f) << 6) | (bytes[at + 1]! & 0x3f);
    case 3:
      return ((lead & 0x0f) << 12) | ((bytes[at + 1]! & 0x3f) << 6) | (bytes[at + 2]! & 0x3f);
    default:
      return (
        ((lead & 0x07) << 18) |
        ((bytes[at + 1]! & 0x3f) << 12) |
        ((bytes[at + 2]! & 0x3f) << 6) |
        (bytes[at + 3]! & 0x3f)
      );
  }
}

/** Append a code point as UTF-16, splitting astral values into a surrogate pair. */
function emit(units: number[], code: number): void {
  if (code > 0xffff) {
    const offset = code - 0x10000;
    units.push(0xd800 + (offset >> 10), 0xdc00 + (offset & 0x3ff));
  } else {
    units.push(code);
  }
}
