import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, describe } from "node:test";

import { parseM3u } from "../src/playlist/parseM3u.ts";
import {
  buildCatchupUrl,
  isWithinArchive,
  archiveRange,
  clampToArchive,
  verifyCatchupResponse,
  CatchupUnavailableError,
  LIVE_EDGE_MARGIN_SECONDS,
} from "../src/catchup/buildUrl.ts";
import type { Channel } from "../src/playlist/types.ts";

const fixture = readFileSync(
  fileURLToPath(new URL("./fixtures/provider-sample.m3u", import.meta.url)),
  "utf8",
);

const NOW = 1_784_000_000; // fixed clock so these tests are deterministic

describe("catchup URL derivation", () => {
  const channel = parseM3u(fixture).channels[0]!;

  test("uses ?utc=&lutc= for catchup-type=shift", () => {
    // This is the form empirically verified against the live provider; the
    // Flussonic path forms returned 200 but served the live edge.
    const url = buildCatchupUrl({
      channel,
      startSeconds: NOW - 7200,
      durationSeconds: 3600,
      nowSeconds: NOW,
    });
    assert.equal(url, `${channel.url}?utc=${NOW - 7200}&lutc=${NOW}`);
  });

  test("appends with & when the stream URL already has a query", () => {
    const withQuery: Channel = { ...channel, url: `${channel.url}?token=abc` };
    const url = buildCatchupUrl({
      channel: withQuery,
      startSeconds: NOW - 60,
      durationSeconds: 60,
      nowSeconds: NOW,
    });
    assert.ok(url.includes("?token=abc&utc="));
  });

  test("refuses programmes outside the 7-day archive", () => {
    assert.throws(
      () =>
        buildCatchupUrl({
          channel,
          startSeconds: NOW - 8 * 86400,
          durationSeconds: 3600,
          nowSeconds: NOW,
        }),
      (e: unknown) => e instanceof CatchupUnavailableError && e.reason === "outside-window",
    );
  });

  test("refuses programmes that have not aired", () => {
    assert.throws(
      () =>
        buildCatchupUrl({ channel, startSeconds: NOW + 60, durationSeconds: 60, nowSeconds: NOW }),
      (e: unknown) => e instanceof CatchupUnavailableError && e.reason === "in-future",
    );
  });

  test("archive window boundaries", () => {
    const c = channel.catchup;
    assert.equal(isWithinArchive(c, NOW - 86400, NOW), true);
    assert.equal(isWithinArchive(c, NOW - 8 * 86400, NOW), false);
    assert.equal(isWithinArchive(undefined, NOW - 60, NOW), false);
  });

  test("expands a provider-supplied catchup-source template", () => {
    const templated: Channel = {
      ...channel,
      catchup: { type: "append", days: 7, source: "http://h/dvr?id={channel}&s={utc}&e={utcend}" },
    };
    const start = NOW - 3600;
    const url = buildCatchupUrl({
      channel: templated,
      startSeconds: start,
      durationSeconds: 1800,
      nowSeconds: NOW,
    });
    assert.equal(url, `http://h/dvr?id=pervyj&s=${start}&e=${start + 1800}`);
  });
});

describe("seekable archive window", () => {
  const channel = parseM3u(fixture).channels[0]!;

  test("spans exactly the advertised catchup-days", () => {
    const range = archiveRange(channel.catchup, NOW)!;
    assert.equal(range.end, NOW);
    assert.equal(range.start, NOW - 7 * 86400);
  });

  test("is null when the channel has no archive", () => {
    assert.equal(archiveRange(undefined, NOW), null);
    assert.equal(archiveRange({ type: "shift", days: 0 }, NOW), null);
  });

  test("clamps a seek past the live edge back behind it", () => {
    // Seeking to exactly "now" requests segments the server has not finished
    // writing, which stalls instead of playing.
    const clamped = clampToArchive(channel.catchup, NOW + 3600, NOW);
    assert.equal(clamped, NOW - LIVE_EDGE_MARGIN_SECONDS);
  });

  test("clamps a seek older than the window to the window start", () => {
    assert.equal(clampToArchive(channel.catchup, NOW - 30 * 86400, NOW), NOW - 7 * 86400);
  });

  test("passes through a position inside the window", () => {
    assert.equal(clampToArchive(channel.catchup, NOW - 3600, NOW), NOW - 3600);
  });

  test("returns null for a channel with no archive, so callers cannot seek", () => {
    assert.equal(clampToArchive(undefined, NOW - 60, NOW), null);
  });
});

describe("catchup response verification", () => {
  // Regression guard for the real failure observed against this provider:
  // an unsupported archive form returns HTTP 200 and live content.
  const manifest = (iso: string): string =>
    `#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXT-X-PROGRAM-DATE-TIME:${iso}\n#EXTINF:5.000,\nhttp://h/s.ts`;

  test("accepts a manifest that actually seeked", () => {
    const requested = Date.parse("2026-07-19T07:45:00Z") / 1000;
    const result = verifyCatchupResponse(manifest("2026-07-19T07:45:14Z"), requested);
    assert.equal(result.ok, true);
  });

  test("rejects a manifest that silently served the live edge", () => {
    const requested = Date.parse("2026-07-19T07:45:00Z") / 1000;
    const result = verifyCatchupResponse(manifest("2026-07-19T09:44:59Z"), requested);
    assert.equal(result.ok, false);
    assert.match(result.reason, /ignored the seek/);
  });

  test("reports honestly when there is nothing to verify against", () => {
    const result = verifyCatchupResponse("#EXTM3U\n#EXTINF:5,\nhttp://h/s.ts", NOW);
    assert.equal(result.ok, false);
    assert.match(result.reason, /no EXT-X-PROGRAM-DATE-TIME/);
  });
});
