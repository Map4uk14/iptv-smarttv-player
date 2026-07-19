/**
 * Benchmark the EPG pipeline against a real provider file.
 *
 *   node --experimental-strip-types scripts/bench-epg.ts <epg.xml.gz> [playlist.m3u]
 *
 * The numbers that matter are peak heap and final index size, not throughput:
 * a webOS TV has ~1–1.5 GB shared with the OS, so this exists to prove the
 * pipeline stays inside a TV's budget rather than a laptop's.
 */

import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { readFileSync } from "node:fs";

import { XmltvStreamParser } from "../src/epg/parseXmltv.ts";
import { EpgIndexBuilder, scheduleBytes, nowAndNext } from "../src/epg/schedule.ts";
import { parseM3u } from "../src/playlist/parseM3u.ts";

const [gzPath, playlistPath] = process.argv.slice(2);
if (!gzPath) {
  console.error("usage: bench-epg.ts <epg.xml.gz> [playlist.m3u]");
  process.exit(1);
}

let filter: Set<string> | undefined;
if (playlistPath) {
  const playlist = parseM3u(readFileSync(playlistPath, "utf8"));
  filter = new Set(playlist.channels.map((c) => c.tvgId).filter((id) => id.length > 0));
  console.log(`playlist: ${playlist.channels.length} channels, ${filter.size} distinct tvg-ids`);
}

const mb = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1) + " MB";

let peakHeap = 0;
const sampleHeap = (): void => {
  const used = process.memoryUsage().heapUsed;
  if (used > peakHeap) peakHeap = used;
};

const builder = new EpgIndexBuilder();
const options: ConstructorParameters<typeof XmltvStreamParser>[0] = {
  onProgramme: (p) => builder.add(p),
};
if (filter) options.channelFilter = filter;
const parser = new XmltvStreamParser(options);

const started = Date.now();
let compressedBytes = 0;
let decodedChars = 0;

const heapTimer = setInterval(sampleHeap, 50);

const source = createReadStream(gzPath);
source.on("data", (chunk) => {
  compressedBytes += chunk.length;
});

const gunzip = source.pipe(createGunzip());
gunzip.setEncoding("utf8");

gunzip.on("data", (chunk: string) => {
  decodedChars += chunk.length;
  parser.write(chunk);
});

gunzip.on("end", () => {
  parser.end();
  clearInterval(heapTimer);
  sampleHeap();

  const parseMs = Date.now() - started;
  const buildStarted = Date.now();
  const index = builder.build();
  const buildMs = Date.now() - buildStarted;
  sampleHeap();

  let indexBytes = 0;
  let titleCount = 0;
  let descCount = 0;
  for (const schedule of index.values()) {
    indexBytes += scheduleBytes(schedule);
    titleCount += schedule.titles.length;
    descCount += schedule.descriptions.length;
  }

  console.log("\n--- input -------------------------------------------------");
  console.log(`compressed          ${mb(compressedBytes)}`);
  console.log(`decompressed        ${mb(decodedChars * 2)} (${decodedChars.toLocaleString()} chars)`);

  console.log("\n--- parse -------------------------------------------------");
  console.log(`channels seen       ${parser.stats.channelsSeen.toLocaleString()}`);
  console.log(`programmes seen     ${parser.stats.programmesSeen.toLocaleString()}`);
  console.log(`programmes kept     ${parser.stats.programmesKept.toLocaleString()}`);
  const discarded = parser.stats.programmesSeen - parser.stats.programmesKept;
  const pct = parser.stats.programmesSeen
    ? ((discarded / parser.stats.programmesSeen) * 100).toFixed(1)
    : "0";
  console.log(`discarded by filter ${discarded.toLocaleString()} (${pct}%)`);
  console.log(`malformed           ${parser.stats.malformed}`);
  console.log(`parse time          ${(parseMs / 1000).toFixed(2)}s`);
  console.log(`index build time    ${(buildMs / 1000).toFixed(2)}s`);

  console.log("\n--- index -------------------------------------------------");
  console.log(`channels indexed    ${index.size}`);
  console.log(`programmes indexed  ${builder.programmeCount.toLocaleString()}`);
  console.log(`unique titles       ${titleCount.toLocaleString()}`);
  console.log(`unique descriptions ${descCount.toLocaleString()}`);
  console.log(`index size          ${mb(indexBytes)}`);
  console.log(`compression         ${(decodedChars / (indexBytes / 2)).toFixed(1)}x vs raw XML`);

  console.log("\n--- memory ------------------------------------------------");
  console.log(`peak heap           ${mb(peakHeap)}`);
  // Peak includes garbage V8 has not bothered to collect on a roomy laptop.
  // Retained-after-GC is the number that predicts behaviour on a TV, where the
  // collector runs far more aggressively. Run with --expose-gc to see it.
  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc) {
    gc();
    gc();
    console.log(`retained after GC   ${mb(process.memoryUsage().heapUsed)}`);
  } else {
    console.log(`retained after GC   (re-run with --expose-gc to measure)`);
  }
  console.log(`(a webOS TV budget is roughly 1-1.5 GB shared with the OS)`);

  // Spot-check a real lookup so the numbers above describe usable data.
  const first = index.keys().next().value;
  if (first) {
    const schedule = index.get(first)!;
    const { now, next } = nowAndNext(schedule, Math.floor(Date.now() / 1000));
    console.log("\n--- spot check --------------------------------------------");
    console.log(`channel "${first}": ${schedule.starts.length} programmes`);
    console.log(`  now:  ${now ? `${new Date(now.start * 1000).toISOString()}  ${now.title}` : "(gap)"}`);
    console.log(`  next: ${next ? `${new Date(next.start * 1000).toISOString()}  ${next.title}` : "(none)"}`);
  }
});

gunzip.on("error", (error) => {
  clearInterval(heapTimer);
  console.error("gunzip failed:", error.message);
  process.exit(1);
});
