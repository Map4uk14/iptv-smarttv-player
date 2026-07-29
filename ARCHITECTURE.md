# IPTV Player — Research Findings & Architecture

## 1. Ground truth: what the sample playlist actually is

Everything below was measured against a real provider playlist on 2026-07-19,
not inferred from the file extension. The playlist URL itself embeds a
subscription token and is kept out of the repository — see `.env.example`.

| Question | Finding |
|---|---|
| Is it HLS? | **No.** Despite the `.m3u8` URL, it is an **extended M3U IPTV playlist**. Server sends `Content-Type: audio/mpegurl` and `Content-Disposition: filename=playlist.m3u`. Contains no `#EXT-X-*` tags. |
| Encoding | UTF-8, **no BOM**, **LF** line endings (0 CR bytes). Cyrillic channel names. |
| Size / scale | 85 KB, 892 lines, **297 channels**, 6 groups. All live TV. |
| Xtream Codes API? | **No** — `player_api.php` returns 404. Pure M3U + XMLTV provider. |
| Stream type | Each channel URL *is* real HLS: `#EXT-X-VERSION:3`, 5s segments. |
| Server type | **Flussonic** — segments are `/{channel}/YYYY/MM/DD/HH/MM/SS-05000.ts?token=…` (DVR archive layout). |
| Rate limit | `X-RateLimit-Limit: 10` on the playlist endpoint. Must not re-fetch aggressively. |

### Header and per-channel fields present

```
#EXTM3U max-conn="2" url-tvg="http://…/epg.xml.gz" catchup-type="shift"
#EXTINF:0 group-title="…" tvg-id="…" tvg-logo="…" tvg-rec="7" catchup-days="7",Первый канал
#EXTGRP:Общероссийские
http://…:8080/USER/PASS/pervyj/video.m3u8
```

`max-conn="2"` is a hard operational constraint: **at most 2 concurrent streams**.
The app must tear down a stream before opening the next (matters for
zapping, PiP, and any background prefetch).

### Catchup — verified, not assumed

`catchup-type="shift"`, `catchup-days="7"`. Three candidate URL conventions were tested
against a live channel with a 2-hour-ago timestamp:

| Form | HTTP | Actually seeked? |
|---|---|---|
| `…/video.m3u8?utc={start}&lutc={now}` | 200 | **Yes** — `PROGRAM-DATE-TIME: 07:45:14Z` (the requested time) |
| `…/timeshift_abs-{start}.m3u8` | 200 | **No** — returned the live edge |
| `…/index-{start}-{dur}.m3u8` | 200 | **No** — returned the live edge |

Two of three return HTTP 200 while silently ignoring the seek. **A 200 is not a
success signal here** — catchup validation must compare the returned
`EXT-X-PROGRAM-DATE-TIME` against the requested time.

### EPG — the dominant constraint

| Metric | Value |
|---|---|
| URL | `url-tvg` → `http://stream.example.com:8080/epg.xml.gz` |
| Transfer size | 33 MB gzip |
| **Uncompressed** | **286 MB XML** |
| Programmes | **683,311** |
| Channels in EPG | 1,277 (playlist uses 297) |
| tvg-id match rate | **297 / 297 — 100%** |
| Layout | Grouped and sorted by channel; uniform `+0300` offset |
| Coverage | 2026-07-05 → 2026-07-27 (~14 days past, ~8 future) |
| Title dedup | 683k total → 121k unique (**5.6×**) |

A webOS TV has roughly 1–1.5 GB RAM shared with the OS. **Nothing may DOM-parse
286 MB.** This is the most likely reason the apps in the market feel slow and
crash-prone, and it is where this app wins.

## 2. Platform research (verified against LG docs)

**Web engine per webOS version** ([LG docs](https://webostv.developer.lge.com/develop/specifications/web-api-and-web-engine)):

| webOS | Year | Chromium |
|---|---|---|
| 26 | 2026 | 132 |
| 25 | 2025 | 120 |
| 24 | 2024 | 108 |
| 23 | 2023 | 94 |
| 22 | 2022 | 87 |
| 6.x | 2021 | 79 |
| 5.x | 2020 | 68 |
| 4.x | 2018–19 | 53 |
| 3.x | 2016–17 | 38 |

**Decision: ship ES5, polyfilled for Chromium 38 (webOS 3.x).**

This was originally "target webOS 4.x+ (Chromium 53), build target `ES2017`",
picked off the table above as a reasonable share of installed base. The
reference TV disagreed: it rejected the bundle with `SyntaxError: Unexpected
token =>`, so its engine predates Chromium 45 — the row below the one that was
guessed. Its DevTools still show the Timeline/Profiles/Resources tabs, removed
in Chrome 57, which corroborates it.

Nothing on-screen said so. A parse error kills the whole script before any of
it runs, so the app installed, launched, and showed a black screen. The lesson
worth keeping: **the Chromium version was assumed from a release table rather
than read off the device**, and every layer downstream inherited the mistake —
including the bundle guard, which enumerated ES2018+ features and so had no
opinion about arrow functions. It now parses the bundle as ES5 with acorn
instead of pattern-matching for syntax someone thought to forbid.

esbuild cannot lower this alone: it refuses to transform async/await below
ES2017, and the app is async throughout. So Vite emits ES2017 and Babel lowers
the built bundle to ES5 afterwards (`scripts/transpile-es5.mjs`), with
`core-js/stable` + `regenerator-runtime` + `whatwg-fetch` for the library gaps
(`fetch` arrived in Chromium 42, `Object.assign` in 45).

Viable only because Solid is used signal-only here — no `createStore`, so no
`Proxy`, which cannot be polyfilled at any price. Verified against the bundle
before committing to the approach.

Cost: 78 kB → 348 kB (117 kB gzipped), loaded from local storage.

**CSS is bound by the same ceiling, and fails far more quietly.** Unsupported
syntax is a parse error you cannot miss; an unsupported *declaration* is simply
dropped, and the only symptom is that the layout is wrong. `inset: 0` (Chromium
87) was the expensive one: `.video-host` had no width or height of its own, so
it collapsed to 0×0 and took the `<video>` inside it with it. The channel played
with correct audio and no picture — which reads as a codec or DRM problem, not a
stylesheet problem. `gap` (Chromium 84, 19 uses) and one `#RRGGBBAA` colour
(Chromium 62) were dropped the same way, giving the "crumbled" spacing.

All three are now written in pre-2016 CSS: four longhand offsets, `> * + *`
margins, `rgba()`. Verified by screenshotting the built app before and after the
rewrite and confirming the layout is unchanged — margins are ancient and behave
identically everywhere, so a modern-browser match is a valid proxy for the TV.
Four containers needed the margin on the element itself instead, because they
place a bare text node beside an element and `* + *` matches elements only.

**Media** ([streaming/DRM](https://webostv.developer.lge.com/develop/specifications/streaming-protocol-drm), [mediaOption](https://webostv.developer.lge.com/develop/guides/mediaoption-parameter)):

- HLS is supported by the **native pipeline** (hardware decode). Configured by
  encoding a `mediaOption` JSON into the `<source>` `type` attribute:
  `video/mp4;mediaOption=` + `encodeURI(JSON.stringify({mediaTransportType:"HLS", …}))`.
- **Confirmed on hardware: the winning form is `application/vnd.apple.mpegurl`
  carrying `mediaOption`, not LG's documented `video/mp4`.** The player tries
  four `<source>` shapes in order and reports which one played; on the reference
  TV that is `hls-mime+mediaOption`, the first. The remaining three stay as a
  fallback for other sets rather than being pruned to the one known-good answer,
  since no other model has been tested.
- **Do not use hls.js on-device.** It would force software demux and destroy
  performance. (Keep it only as a desktop-dev fallback.)
- MPEG-DASH is **not** supported. HLS only.
- **`EXT-X-PROGRAM-DATE-TIME` is not exposed to the app.** Consequence: during
  catchup the app must track the requested UTC offset itself and derive the
  wall-clock position as `requestedStart + video.currentTime`. It cannot read it
  back from the player.
- Multi-audio: partial, webOS 5+. WebVTT multi-subtitle: VOD only, webOS 5+.
  These must degrade gracefully on 4.x.
- No `EXT-X-DISCONTINUITY` beyond PTS (4.0+); no trick-play/rate ≠ 1.0.

**Storage:** localStorage capped at **16 MB** (webOS 3.5+); IndexedDB gets the
large quota but the exact figure is device-dependent and not guaranteed. Packaged
apps lose their data on update/uninstall — so the EPG cache must be treated as
**disposable and rebuildable**, never as the source of truth.

**Tooling:** `@webos-tools/cli` (renamed from `@webosose/ares-cli` in v3.0.2) —
`ares-package`, `ares-install`, `ares-launch`, `ares-inspect`. Node v25.6.1 and
npm 11.12.0 are present locally.

## 3. Architecture

### Code-sharing strategy

The honest answer, not the maximalist one:

- **webOS + Tizen are both web platforms** → one TypeScript app covers both with
  near-total code sharing. That is the bulk of the smart-TV install base and is
  where we start.
- **Android TV / Fire TV** are best served natively (ExoPlayer). They do *not*
  get a WebView port — that is precisely the compromise that makes competitors
  feel bad.
- **tvOS** cannot meaningfully run a web app.

So the sharable asset is not the UI — it is the **domain core**. Everything
hard-won (format detection, parsing, EPG indexing, catchup URL derivation) lives
in a pure-TypeScript package with **zero DOM and zero platform dependencies**,
runnable under Node and unit-testable on a laptop. Later native ports reuse its
*logic and test corpus* even where the language differs.

```
packages/core/          pure TS, no DOM — the portable brain
  src/playlist/         format detection + M3U/HLS parsers
  src/epg/              streaming XMLTV parser + compact index
  src/catchup/          catchup URL derivation
  src/platform/         interfaces only (Storage, Http, Player)

apps/webos/             Solid + Vite + ares packaging (webOS first)
  src/platform/         webOS implementations of the core interfaces
```

### Framework

**Solid.js + TypeScript + Vite.** No virtual DOM, ~7 KB runtime, fine-grained
updates — on a Chromium-53-class CPU this matters far more than developer
familiarity. React's reconciler is the wrong tax to pay on this hardware.

Custom-built, not imported: **spatial (D-pad) navigation** and **list
virtualization**. Both are core to TV feel and every off-the-shelf option is
tuned for mouse/desktop.

### The EPG pipeline (the differentiator)

Never materialize the 286 MB. Stream it:

1. **Fetch** `epg.xml.gz` as a stream; inflate incrementally.
2. **Scan**, don't DOM-parse — a chunked tokenizer that emits `<programme>`
   records, holding only a small window in memory.
3. **Filter early** to tvg-ids actually referenced by loaded playlists —
   discards ~77% (1,277 → 297 channels) before any allocation.
4. **Dictionary-encode**: titles dedupe 5.6×. Titles and descriptions go to a
   string table; programmes become fixed-width records
   `(startDelta:u32, duration:u16, titleRef:u32, descRef:u32)`.
5. **Store per-channel blobs** in IndexedDB, keyed by channel id, so rendering
   the guide loads only the visible rows.
6. **Descriptions load lazily**, only when the info panel opens.

### Measured results (real provider feed, not projections)

`packages/core/scripts/bench-epg.ts` against the live 286 MB EPG:

| | |
|---|---|
| Programmes seen | 683,311 |
| Kept after channel filter | 160,930 (**76.4% discarded**) |
| Channels indexed | 297 |
| Final index | **23.1 MB** (18.2× smaller than the raw XML) |
| Unique titles / descriptions | 38,567 / 32,422 |
| Parse + index time | ~6 s |
| Peak heap | **166 MB** |
| Retained after GC | **55 MB** |

Parsing runs in a **Web Worker**, streamed through
`DecompressionStream('gzip')` → `TextDecoderStream`, so the decompressed XML
never exists as a single buffer (verified: 17,997 discrete chunks).

### The sliced-string trap

The first working version retained **674 MB** against a 23 MB index. Cause:
`String.prototype.slice` in V8 does not copy — it returns a view holding a
pointer to its parent. Every interned title pinned the entire surrounding
megabyte of XML.

Worth recording because three plausible fixes were wrong:

1. `('' + s)`, `s.slice()`, `s.normalize()`, `s.padEnd(n)`, `s.repeat(1)` and
   `s.replace(/[\s\S]/g, m => m)` all read like copies and free nothing.
2. A micro-benchmark picked `JSON.parse(JSON.stringify(s))` — measured against a
   one-byte Latin-1 parent. The real EPG is Cyrillic, i.e. two-byte, where V8
   behaves differently. **Benchmark fixtures must match the real data's string
   representation.**
3. Measuring candidates sequentially in one process gave contradictory verdicts
   run to run. Retention must be measured one candidate per process.

Fix: a `TextEncoder`/`TextDecoder` round-trip, the only method clean in every
measurement. Guarded by the "interned titles do not retain the source buffer"
test, which was itself verified to fail (38.5 MB) when the fix is removed.

### Design consequences of the findings

- `max-conn="2"` → a single owned player instance; explicit teardown before
  re-open; no speculative prefetch of streams.
- No `PROGRAM-DATE-TIME` → app-side playback-position clock during catchup.
- Rate limit 10 → playlist refresh is throttled and cached with ETag.
- No Xtream API → **this provider has no VOD or Series content** (297 live
  channels only). The data model still carries VOD/Series because other
  providers do, but expect those sections to be empty here.

## 4. Roadmap

1. **Core parser + format detection** (+ test corpus from the real playlist) ← current
2. EPG streaming parser, indexer, worker
3. webOS shell: spatial nav, virtualized channel list, native player binding
4. Guide UI, catchup, favorites, search, multi-playlist
5. Image cache, startup optimization, packaging
6. Tizen (share ~everything), then native Android TV / tvOS
