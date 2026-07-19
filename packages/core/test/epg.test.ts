import { strict as assert } from "node:assert";
import { test, describe } from "node:test";

import { parseXmltvTime } from "../src/epg/time.ts";
import { XmltvStreamParser, decodeEntities, type XmltvProgramme } from "../src/epg/parseXmltv.ts";
import {
  EpgIndexBuilder,
  adjacentProgramme,
  firstProgrammeFrom,
  nowAndNext,
  programmeAt,
  programmesBetween,
} from "../src/epg/schedule.ts";

describe("XMLTV timestamps", () => {
  test("parses the provider's canonical form with offset", () => {
    // 2026-07-05 10:00:00 +0300 == 07:00:00 UTC
    const t = parseXmltvTime("20260705100000 +0300");
    assert.equal(new Date(t * 1000).toISOString(), "2026-07-05T07:00:00.000Z");
  });

  test("honours negative offsets", () => {
    const t = parseXmltvTime("20260705100000 -0500");
    assert.equal(new Date(t * 1000).toISOString(), "2026-07-05T15:00:00.000Z");
  });

  test("accepts Z, GMT, and truncated forms", () => {
    assert.equal(new Date(parseXmltvTime("20260705100000Z") * 1000).toISOString(), "2026-07-05T10:00:00.000Z");
    assert.equal(new Date(parseXmltvTime("20260705100000 GMT") * 1000).toISOString(), "2026-07-05T10:00:00.000Z");
    assert.equal(new Date(parseXmltvTime("202607051000") * 1000).toISOString(), "2026-07-05T10:00:00.000Z");
    assert.equal(new Date(parseXmltvTime("20260705") * 1000).toISOString(), "2026-07-05T00:00:00.000Z");
  });

  test("applies the default offset only when the stamp carries none", () => {
    // Guarding against a whole-guide time shift when a generator omits offsets.
    assert.equal(parseXmltvTime("20260705100000", 180), parseXmltvTime("20260705100000 +0300"));
    assert.equal(parseXmltvTime("20260705100000 +0000", 180), parseXmltvTime("20260705100000Z"));
  });

  test("handles leap days and century boundaries", () => {
    assert.equal(new Date(parseXmltvTime("20240229120000Z") * 1000).toISOString(), "2024-02-29T12:00:00.000Z");
    assert.equal(new Date(parseXmltvTime("20000229000000Z") * 1000).toISOString(), "2000-02-29T00:00:00.000Z");
  });

  test("survives past 2038 (Uint32 storage, not Int32)", () => {
    const t = parseXmltvTime("20400101000000Z");
    assert.ok(t > 2_147_483_647, "should exceed the Int32 ceiling");
    assert.equal(new Date(t * 1000).toISOString(), "2040-01-01T00:00:00.000Z");
  });

  test("returns NaN for junk rather than a wrong time", () => {
    assert.ok(Number.isNaN(parseXmltvTime("")));
    assert.ok(Number.isNaN(parseXmltvTime("not-a-date")));
    assert.ok(Number.isNaN(parseXmltvTime("2026")));
  });
});

describe("entity decoding", () => {
  test("decodes named, decimal and hex entities", () => {
    assert.equal(decodeEntities("Tom &amp; Jerry"), "Tom & Jerry");
    assert.equal(decodeEntities("&lt;b&gt;"), "<b>");
    assert.equal(decodeEntities("&#1053;&#1086;&#1074;"), "Нов");
    assert.equal(decodeEntities("&#x41;&#x42;"), "AB");
  });

  test("leaves unknown entities intact instead of destroying text", () => {
    assert.equal(decodeEntities("100&percnt; &unknown;"), "100&percnt; &unknown;");
  });
});

// --------------------------------------------------------------------------

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE tv SYSTEM "xmltv.dtd">
<tv generator-info-name="test">
<channel id="pervyj">
    <display-name lang="ru">Первый канал</display-name>
    <icon src="http://logo/pervyj.png"/>
</channel>
<channel id="ignored">
    <display-name>Not In Playlist</display-name>
</channel>
<programme start="20260705100000 +0300" stop="20260705101500 +0300" channel="pervyj">
    <title lang="ru">Новости</title>
</programme>
<programme start="20260705101500 +0300" stop="20260705111000 +0300" channel="pervyj">
    <title lang="ru">Tom &amp; Jerry</title>
    <desc lang="ru">Description here</desc>
</programme>
<programme start="20260705120000 +0300" stop="20260705130000 +0300" channel="ignored">
    <title>Should be filtered</title>
</programme>
</tv>`;

function parseAll(text: string, chunkSize: number, filter?: Set<string>) {
  const programmes: XmltvProgramme[] = [];
  const channels: { id: string; displayName: string; icon?: string }[] = [];
  const options: ConstructorParameters<typeof XmltvStreamParser>[0] = {
    onProgramme: (p) => programmes.push(p),
    onChannel: (c) => channels.push(c),
  };
  if (filter) options.channelFilter = filter;

  const parser = new XmltvStreamParser(options);
  for (let i = 0; i < text.length; i += chunkSize) {
    parser.write(text.slice(i, i + chunkSize));
  }
  parser.end();
  return { programmes, channels, stats: parser.stats };
}

describe("streaming XMLTV parser", () => {
  test("extracts channels and programmes", () => {
    const { programmes, channels } = parseAll(SAMPLE, SAMPLE.length);
    assert.equal(channels.length, 2);
    assert.equal(channels[0]!.id, "pervyj");
    assert.equal(channels[0]!.displayName, "Первый канал");
    assert.equal(channels[0]!.icon, "http://logo/pervyj.png");

    assert.equal(programmes.length, 3);
    assert.equal(programmes[0]!.title, "Новости");
    assert.equal(programmes[1]!.title, "Tom & Jerry");
    assert.equal(programmes[1]!.description, "Description here");
  });

  test("produces identical output at every chunk size", () => {
    // Elements spanning chunk boundaries is the defining risk of a streaming
    // scanner; 1-byte chunks split every single tag.
    const reference = JSON.stringify(parseAll(SAMPLE, SAMPLE.length).programmes);
    for (const size of [1, 2, 3, 7, 13, 64, 512, 4096]) {
      const actual = JSON.stringify(parseAll(SAMPLE, size).programmes);
      assert.equal(actual, reference, `chunk size ${size} diverged`);
    }
  });

  test("channel filter discards non-matching channels", () => {
    const { programmes, channels, stats } = parseAll(SAMPLE, 64, new Set(["pervyj"]));
    assert.equal(programmes.length, 2);
    assert.equal(channels.length, 1);
    assert.equal(stats.programmesSeen, 3);
    assert.equal(stats.programmesKept, 2);
  });

  test("handles self-closing channel elements", () => {
    const xml = '<tv><channel id="a"/><channel id="b"><display-name>B</display-name></channel></tv>';
    const { channels } = parseAll(xml, 5);
    assert.deepEqual(channels.map((c) => c.id), ["a", "b"]);
  });

  test("substitutes a stop time when it is missing or invalid", () => {
    const xml = '<tv><programme start="20260705100000 +0300" channel="a"><title>T</title></programme></tv>';
    const { programmes } = parseAll(xml, 32);
    assert.equal(programmes.length, 1);
    assert.equal(programmes[0]!.stop - programmes[0]!.start, 1800);
  });

  test("skips malformed entries and keeps going", () => {
    const xml =
      '<tv><programme start="garbage" channel="a"><title>Bad</title></programme>' +
      '<programme channel="a"><title>NoStart</title></programme>' +
      '<programme start="20260705100000 +0300" stop="20260705110000 +0300" channel="a"><title>Good</title></programme></tv>';
    const { programmes, stats } = parseAll(xml, 16);
    assert.equal(programmes.length, 1);
    assert.equal(programmes[0]!.title, "Good");
    assert.equal(stats.malformed, 2);
  });

  test("does not accumulate the whole document in memory", () => {
    // 20k programmes fed in small chunks; the buffer must stay bounded.
    let xml = "<tv>";
    for (let i = 0; i < 20_000; i++) {
      xml += `<programme start="20260705100000 +0300" stop="20260705110000 +0300" channel="a"><title>P${i}</title></programme>`;
    }
    xml += "</tv>";

    let count = 0;
    const parser = new XmltvStreamParser({ onProgramme: () => count++ });
    for (let i = 0; i < xml.length; i += 8192) parser.write(xml.slice(i, i + 8192));
    parser.end();

    assert.equal(count, 20_000);
    const internal = parser as unknown as { buffer: string };
    assert.ok(internal.buffer.length < 64 * 1024, `buffer grew to ${internal.buffer.length}`);
  });
});

// --------------------------------------------------------------------------

describe("compact schedule index", () => {
  const build = (entries: [number, number, string, string?][]) => {
    const builder = new EpgIndexBuilder();
    for (const [start, stop, title, desc] of entries) {
      const p: XmltvProgramme = desc
        ? { channelId: "a", start, stop, title, description: desc }
        : { channelId: "a", start, stop, title };
      builder.add(p);
    }
    return builder.build().get("a")!;
  };

  const schedule = build([
    [1000, 2000, "One"],
    [2000, 3000, "Two", "desc two"],
    [4000, 5000, "Three"], // deliberate gap 3000..4000
  ]);

  test("round-trips programmes through typed arrays", () => {
    assert.equal(programmeAt(schedule, 1500)?.title, "One");
    assert.equal(programmeAt(schedule, 2000)?.title, "Two");
    assert.equal(programmeAt(schedule, 2999)?.title, "Two");
    assert.equal(programmeAt(schedule, 4500)?.title, "Three");
    assert.equal(programmeAt(schedule, 2500)?.description, "desc two");
  });

  test("reports a gap as no programme rather than a stale one", () => {
    assert.equal(programmeAt(schedule, 3500), undefined);
    assert.equal(programmeAt(schedule, 500), undefined);
    assert.equal(programmeAt(schedule, 99999), undefined);
  });

  test("now/next during a programme", () => {
    const { now, next } = nowAndNext(schedule, 1500);
    assert.equal(now?.title, "One");
    assert.equal(next?.title, "Two");
  });

  test("now/next inside a gap gives no 'now' but the correct 'next'", () => {
    const { now, next } = nowAndNext(schedule, 3500);
    assert.equal(now, undefined);
    assert.equal(next?.title, "Three");
  });

  test("programmesBetween includes programmes that started before the window", () => {
    const rows = programmesBetween(schedule, 1500, 4500);
    assert.deepEqual(rows.map((p) => p.title), ["One", "Two", "Three"]);
    assert.deepEqual(programmesBetween(schedule, 2100, 2200).map((p) => p.title), ["Two"]);
    assert.equal(programmesBetween(schedule, 3100, 3900).length, 0);
  });

  test("deduplicates repeated titles within a channel", () => {
    const repeated = build([
      [1000, 2000, "Новости"],
      [3000, 4000, "Новости"],
      [5000, 6000, "Новости"],
      [7000, 8000, "Фильм"],
    ]);
    assert.equal(repeated.titles.length, 2, "three identical titles should intern to one");
    assert.equal(repeated.starts.length, 4);
  });

  test("sorts out-of-order input so binary search stays correct", () => {
    // Unsorted input would make every lookup silently wrong.
    const unsorted = build([
      [5000, 6000, "Third"],
      [1000, 2000, "First"],
      [3000, 4000, "Second"],
    ]);
    assert.deepEqual(Array.from(unsorted.starts), [1000, 3000, 5000]);
    assert.equal(programmeAt(unsorted, 3500)?.title, "Second");
    assert.equal(programmeAt(unsorted, 5500)?.title, "Third");
  });

  test("stores times beyond the 2038 Int32 boundary", () => {
    const future = build([[2_500_000_000, 2_500_003_600, "Future"]]);
    assert.equal(programmeAt(future, 2_500_001_000)?.title, "Future");
  });

  test("steps between adjacent programmes for guide navigation", () => {
    assert.equal(adjacentProgramme(schedule, 1000, 1)?.title, "Two");
    assert.equal(adjacentProgramme(schedule, 2000, 1)?.title, "Three");
    assert.equal(adjacentProgramme(schedule, 2000, -1)?.title, "One");
    // Ends of the list must not wrap — a guide that loops is disorienting.
    assert.equal(adjacentProgramme(schedule, 1000, -1), undefined);
    assert.equal(adjacentProgramme(schedule, 4000, 1), undefined);
  });

  test("steps sensibly from a time inside a gap", () => {
    // 3500 is in the 3000..4000 gap; the previous programme covers it.
    assert.equal(adjacentProgramme(schedule, 3500, 1)?.title, "Three");
    assert.equal(adjacentProgramme(schedule, 3500, -1)?.title, "One");
  });

  test("seeds the guide cursor from an arbitrary time", () => {
    assert.equal(firstProgrammeFrom(schedule, 1500)?.title, "One");
    assert.equal(firstProgrammeFrom(schedule, 3500)?.title, "Three"); // gap -> next
    assert.equal(firstProgrammeFrom(schedule, 0)?.title, "One");
    assert.equal(firstProgrammeFrom(schedule, 99999), undefined);
  });

  /**
   * Regression guard for the sliced-string retention bug.
   *
   * V8's slice() returns a view onto its parent, so interning titles taken from
   * the EPG buffer used to pin 674 MB of retained heap against a 23 MB index.
   * Several plausible "fixes" ('' + s, s.slice(), s.normalize(), s.padEnd(n))
   * compile, read correctly, and free nothing — so this asserts memory
   * behaviour rather than the presence of a call.
   *
   * Sizing is deliberate and was arrived at the hard way. An earlier version
   * used a 16 MB parent and 500 slices and could not discriminate at all: the
   * one-off cost of materialising a `repeat()`-built ConsString on first slice
   * (~15 MB, incurred even when every slice is discarded) swamped the signal.
   * Enough slices are kept here that a retained parent is unambiguous:
   *
   *   parent held  -> ~38 MB     parent released -> ~5 MB (the copies alone)
   *
   * The primary evidence for this optimisation is still the real-file
   * benchmark (scripts/bench-epg.ts): 674 MB retained before, 55 MB after.
   * This test is the cheap guard; that benchmark is the proof.
   *
   * Needs --expose-gc; skipped otherwise so the normal suite stays runnable.
   */
  test("interned titles do not retain the source buffer", { skip: !globalThis.gc }, () => {
    const gc = globalThis.gc!;
    const SLICES = 20_000;
    const SLICE_LEN = 120;

    gc();
    gc();
    const before = process.memoryUsage().heapUsed;

    // Two-byte (Cyrillic) content on purpose: V8 represents one-byte and
    // two-byte strings differently, and a Latin-1 fixture hid this bug once.
    let parent: string | null = "Программа передач ".repeat(1_100_000); // ~38 MB
    const builder = new EpgIndexBuilder();
    for (let i = 0; i < SLICES; i++) {
      const offset = (i * 977) % (parent.length - SLICE_LEN);
      builder.add({
        channelId: "a",
        start: 1000 + i * 100,
        stop: 1000 + i * 100 + 90,
        title: parent.slice(offset, offset + SLICE_LEN),
      });
    }
    const index = builder.build();
    parent = null;
    gc();
    gc();

    const retainedMb = (process.memoryUsage().heapUsed - before) / 1024 / 1024;
    assert.equal(index.get("a")!.starts.length, SLICES);
    assert.ok(
      retainedMb < 20,
      `retained ${retainedMb.toFixed(1)} MB — the ~38 MB parent buffer is being held alive ` +
        `(expected ~5 MB of copies)`,
    );
  });
});
