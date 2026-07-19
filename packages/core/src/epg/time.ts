/**
 * XMLTV timestamp handling.
 *
 * The spec's format is `YYYYMMDDHHMMSS ±HHMM`, but generators truncate it
 * freely and disagree about the offset. Observed and handled:
 *
 *   20260705100000 +0300     canonical (what this provider emits)
 *   20260705100000 GMT       named zone
 *   20260705100000Z          Zulu
 *   20260705100000           no offset at all
 *   202607051000             minute precision
 *   20260705                 date only
 *
 * Everything is normalised to epoch **seconds**, which is what the rest of the
 * app works in. Date objects are avoided in the hot path — parsing 683k
 * timestamps through `new Date()` is measurably slower and drags in the host
 * timezone, which we never want to depend on.
 */

/**
 * Parse an XMLTV timestamp to epoch seconds, or NaN if unparseable.
 *
 * `defaultOffsetMinutes` applies only when the stamp carries no offset of its
 * own. Treating a missing offset as UTC would shift a whole guide by hours, so
 * callers should pass the playlist's known offset when they have one.
 */
export function parseXmltvTime(raw: string, defaultOffsetMinutes = 0): number {
  const s = raw.trim();
  if (s.length < 8) return Number.NaN;

  const year = digits(s, 0, 4);
  const month = digits(s, 4, 2);
  const day = digits(s, 6, 2);
  if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day)) return Number.NaN;

  const hour = s.length >= 10 ? digits(s, 8, 2) : 0;
  const minute = s.length >= 12 ? digits(s, 10, 2) : 0;
  const second = s.length >= 14 ? digits(s, 12, 2) : 0;
  if (Number.isNaN(hour) || Number.isNaN(minute) || Number.isNaN(second)) return Number.NaN;

  // Offset: whatever follows the numeric portion.
  let offsetMinutes = defaultOffsetMinutes;
  const rest = s.slice(14).trim();
  if (rest.length > 0) {
    const parsed = parseOffset(rest);
    if (parsed !== null) offsetMinutes = parsed;
  }

  const utcDays = daysFromCivil(year, month, day);
  return utcDays * 86400 + hour * 3600 + minute * 60 + second - offsetMinutes * 60;
}

function digits(s: string, start: number, length: number): number {
  let value = 0;
  for (let i = start; i < start + length; i++) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) return Number.NaN;
    value = value * 10 + (c - 48);
  }
  return value;
}

function parseOffset(raw: string): number | null {
  const s = raw.trim();
  if (s === "Z" || s.toUpperCase() === "UTC" || s.toUpperCase() === "GMT") return 0;

  const sign = s[0] === "-" ? -1 : s[0] === "+" ? 1 : 0;
  if (sign === 0) return null;

  const body = s.slice(1);
  if (body.length === 4) {
    const h = digits(body, 0, 2);
    const m = digits(body, 2, 2);
    if (Number.isNaN(h) || Number.isNaN(m)) return null;
    return sign * (h * 60 + m);
  }
  if (body.length === 2) {
    const h = digits(body, 0, 2);
    return Number.isNaN(h) ? null : sign * h * 60;
  }
  return null;
}

/**
 * Days since the Unix epoch for a civil date, by Howard Hinnant's algorithm.
 * Pure arithmetic — no Date object, no host timezone, no DST surprises.
 */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}
