# IPTV Player

A fast IPTV player for smart TVs, LG webOS first. See [ARCHITECTURE.md](ARCHITECTURE.md)
for the research the design is based on.

## Status

| Piece | State |
|---|---|
| Playlist detection, M3U parser, catchup URLs | Done — verified against the live provider |
| XMLTV EPG: streaming parser, compact index, worker | Done — 683k programmes → 23 MB index, 55 MB retained |
| Channel list with now/next + progress | Done |
| Groups sidebar, favourites, search | Done |
| Playback, zapping, info bar | Done, **not yet run on a TV** |
| EPG cache in IndexedDB, settings in localStorage | Done |
| Full guide grid (time × channel) | Done — virtualized on both axes |
| Catchup / replay from the guide | Done — verified against the live server |
| Transport controls: seek, skip, jump to live | Done — server honours seeks with 0s drift |
| Pause live TV with timeshift resume | Done |
| Subtitles / multiple audio tracks | Not started — needs a real TV to develop against |
| Multiple playlists, settings screen | Not started |
| VOD / Series browsing | Not started (this provider has none) |
| Image caching | Not started — currently relies on the browser cache |

64 tests passing.

## Using it

| Key | Action |
|---|---|
| ▲▼ | Move (wraps) |
| ◀▶ | Switch between groups and channels |
| OK | Watch / open panel |
| Back | Panel ⇄ fullscreen; exits app from the top level |
| CH +/− | Jump 10, or zap while watching |
| **Red** | Toggle favourite |
| **Green** | TV guide |
| **Yellow** | Search (webOS raises its on-screen keyboard) |
| **Blue** | Jump to groups |
| INFO | Show the info bar |

In the guide: ◀▶ steps programme by programme, ▲▼ changes channel holding your
place in time, CH± jumps 5 channels. A **⟲** badge marks programmes still inside
the 7-day archive — press OK on one to replay it. Programmes that have aired but
fallen out of the archive are dimmed, so it is clear before you press anything.

### While watching

| Key | Action |
|---|---|
| OK | Show transport controls; again to play/pause |
| ◀▶ | Skip 30s (hold to scrub — the seek lands when you stop) |
| ⏪ ⏩ | Skip 5 minutes |
| ❚❚ / ▶ | Pause — see below |
| **Blue** / ■ | Jump back to live |
| ▲▼ | Change channel (always returns to live) |
| Back | Close controls, then return to the channel list |

**Pause works like a DVR.** On a channel with an archive, pausing a live stream
records the moment, and resuming continues from there rather than snapping back
to live — you keep whatever you missed. The offset from live is shown while you
are behind it. On channels without an archive, seeking and timeshift are
unavailable and the controls say so instead of failing silently.

Seeks are committed on a short debounce rather than per keypress, because each
one re-requests the stream and this provider allows only two concurrent
connections.

## Layout

```
packages/core/    pure TypeScript domain logic — no DOM, runs under Node
apps/webos/       the webOS TV app (Solid + Vite), packaged as .ipk
```

## Setup

```bash
npm install
cp apps/webos/.env.example apps/webos/.env.local
# then put your playlist URL in .env.local
```

The playlist URL embeds your subscription token, so `.env.local` is git-ignored.
Never commit it.

## Testing without a TV

```bash
npm run dev --workspace @iptv/webos     # http://localhost:5173
```

Then open Chrome at 1920x1080 (DevTools → device toolbar → responsive → 1920x1080).

| Key | Acts as |
|---|---|
| Arrows | D-pad |
| Enter | OK |
| Esc / Backspace | Back |
| PageUp / PageDown | Channel ±10 |
| 0–9 | Number keys |

**Video does play in the browser.** Desktop Chrome cannot demux HLS natively, so
in development only the app falls back to hls.js. This is aliased away in
production builds — `npm run check-bundle` fails the build if real hls.js ever
reaches the TV bundle, because a JS demuxer on webOS means software decode.

So the browser validates: playlist fetch and parsing, all 297 channels and
logos, navigation, layout, zapping, and that the stream URLs are genuinely
playable.

It does **not** validate the webOS media path. See below.

### Why the LG Simulator won't help here

The [webOS TV Simulator](https://webostv.developer.lge.com/develop/tools/simulator-introduction)
runs on a PC and is useful for layout and Luna APIs, but LG's own docs state it
**does not support `mediaOption`** and its "video and audio specifications are
different from actual TV devices". `mediaOption` is precisely the open question
in `src/platform/player.ts`, so the Simulator cannot settle it.

The older VirtualBox-based Emulator is discontinued from webOS 22 and also
mis-maps media keys.

**Conclusion:** browser testing covers everything except the media pipeline.
That one question needs real hardware, and the player reports which strategy
succeeded on-screen so a single run on the TV answers it.

## Run tests

```bash
npm test --workspace @iptv/core
```

## Put it on the TV

Retail LG TVs cannot install `.ipk` files from a USB stick — that path exists
only on LG's digital-signage models. On a consumer TV the options are Developer
Mode (below), rooting, or the LG Content Store.

**One-time setup**

1. Create a free account at <https://developer.lge.com>.
2. On the TV, install **Developer Mode** from LG Content Store, sign in, enable
   Dev Mode. The TV restarts and shows its IP address.
3. Register the TV once:
   ```bash
   npx ares-setup-device --add tv --info "host=<TV_IP>,port=9922,username=prisoner"
   npx ares-novacom --device tv --getkey     # prompts for the on-screen passphrase
   ```

**Each deploy**

```bash
npm run deploy --workspace @iptv/webos    # build + package + install + launch
```

Or step by step:

```bash
npm run package --workspace @iptv/webos   # -> apps/webos/out/com.mark.iptv_0.1.0_all.ipk
npm run install-tv --workspace @iptv/webos
npm run launch-tv --workspace @iptv/webos
```

**Debugging on-device** — this is how you see console output from the TV:

```bash
npx ares-inspect --device tv --app com.mark.iptv --open
```

### Developer Mode expiry

Sessions are time-limited. Open the Developer Mode app and press **EXTEND**
before it lapses, or the app stops working and you re-authenticate. It also
disables after 10 reboots without network. This is the main ongoing annoyance
of the non-rooted route.

## Notes on this provider

- 297 live channels. No VOD or Series — there is no Xtream API, so that content
  does not exist on this account.
- `max-conn="2"`: at most two concurrent streams. The player tears down the old
  stream before opening a new one for this reason.
- 7-day catchup via `?utc=&lutc=`. Two other conventions return HTTP 200 while
  silently serving live TV — see ARCHITECTURE.md.
- The EPG is 286 MB uncompressed. It must never be loaded into memory whole.
