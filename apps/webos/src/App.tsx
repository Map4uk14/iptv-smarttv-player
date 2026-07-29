/**
 * Application shell.
 *
 * Interaction model, chosen to match what TV users already expect:
 *
 *   watch   fullscreen video; OK/INFO shows the info bar, up/down zaps
 *   browse  overlay panel over the still-playing video
 *           left column = groups, right column = channels
 *           left/right moves between columns, Back closes
 *   search  text field; webOS raises its own keyboard for a focused <input>
 *
 * Video keeps playing behind the browse panel. Blanking the screen while
 * choosing a channel is a large part of why some apps feel cheap.
 *
 * Colour buttons follow the common convention: red favourites, green guide,
 * yellow search, blue groups.
 */

import { batch, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";

import { parseM3u } from "../../../packages/core/src/playlist/parseM3u.ts";
import { detectFormat } from "../../../packages/core/src/playlist/detect.ts";
import type { Channel, Playlist } from "../../../packages/core/src/playlist/types.ts";
import {
  adjacentProgramme,
  firstProgrammeFrom,
  nowAndNext,
  programmeAt,
  type Programme,
} from "../../../packages/core/src/epg/schedule.ts";
import {
  buildCatchupUrl,
  isWithinArchive,
  archiveRange,
  clampToArchive,
  CatchupUnavailableError,
} from "../../../packages/core/src/catchup/buildUrl.ts";

import { installRemoteHandler, type RemoteEvent } from "./platform/keys.ts";
import { WebOSPlayer, type PlaybackStatus } from "./platform/player.ts";
import { loadSettings, saveSettings, type Settings } from "./platform/storage.ts";
import { EpgService, EPG_MAX_AGE_MS, type EpgProgress } from "./epg/epgService.ts";
import { ChannelList, type NowNext } from "./ui/ChannelList.tsx";
import { Sidebar, type GroupEntry } from "./ui/Sidebar.tsx";
import { InfoBar } from "./ui/InfoBar.tsx";
import { Guide, type GuideSelection } from "./ui/Guide.tsx";
import { PlayerControls } from "./ui/PlayerControls.tsx";
import { PLAYLIST_URL } from "./config.ts";

type Screen = "loading" | "error" | "browse" | "watch" | "guide";
type Column = "sidebar" | "list";

/** Live edge, or a specific archived programme being replayed. */
interface PlaybackSession {
  readonly channelId: string;
  readonly mode: "live" | "catchup";
  /** Set only for catchup — the programme whose archive is playing. */
  readonly programme?: Programme;
  /** Epoch seconds the stream was asked to start from (catchup only). */
  readonly startedAt?: number;
}

const ALL_GROUP = "__all__";
const FAVOURITES_GROUP = "favourites";
const LIST_VIEWPORT = 812;
const GUIDE_VIEWPORT = 780;
const GUIDE_WINDOW_MINUTES = 210;

export function App() {
  const [screen, setScreen] = createSignal<Screen>("loading");
  const [playlist, setPlaylist] = createSignal<Playlist | null>(null);
  const [errorText, setErrorText] = createSignal("");
  const [settings, setSettings] = createSignal<Settings>(loadSettings());

  const [groupId, setGroupId] = createSignal(ALL_GROUP);
  const [column, setColumn] = createSignal<Column>("list");
  const [selected, setSelected] = createSignal(0);
  const [session, setSession] = createSignal<PlaybackSession | null>(null);
  const playingId = (): string | null => session()?.channelId ?? null;

  const [guideWindowStart, setGuideWindowStart] = createSignal(alignToHalfHour(Date.now() / 1000));
  const [guideSelection, setGuideSelection] = createSignal<GuideSelection>({
    channelIndex: 0,
    programme: null,
  });
  const [toast, setToast] = createSignal("");

  // --- transport state ---------------------------------------------------
  const [paused, setPaused] = createSignal(false);
  const [showControls, setShowControls] = createSignal(false);
  /** Scrub target while seeking, epoch seconds; null when not scrubbing. */
  const [seekTarget, setSeekTarget] = createSignal<number | null>(null);

  const [status, setStatus] = createSignal<PlaybackStatus>({ state: "idle" });
  const [showInfo, setShowInfo] = createSignal(false);
  const [epgProgress, setEpgProgress] = createSignal<EpgProgress>({ state: "idle", programmes: 0 });
  const [searchQuery, setSearchQuery] = createSignal("");
  const [searching, setSearching] = createSignal(false);

  // A single ticking clock drives every progress bar and the on-screen time.
  // One timer for the whole UI, not one per row.
  const [nowSeconds, setNowSeconds] = createSignal(Math.floor(Date.now() / 1000));
  /** Elapsed media time, polled from the player; drives the catchup clock. */
  const [mediaTime, setMediaTime] = createSignal(0);

  let videoHost!: HTMLDivElement;
  let searchInput: HTMLInputElement | undefined;
  let player: WebOSPlayer | null = null;
  let infoTimer: number | undefined;
  let toastTimer: number | undefined;
  let controlsTimer: number | undefined;
  let seekCommitTimer: number | undefined;
  /** Wall clock at the moment the user paused a live stream. */
  let pausedAtWallClock: number | null = null;

  const epg = new EpgService((progress) => setEpgProgress(progress));

  // --- derived data -------------------------------------------------------

  const allChannels = (): readonly Channel[] => playlist()?.channels ?? [];

  const favouriteSet = createMemo(() => new Set(settings().favourites));
  const isFavourite = (channel: Channel): boolean => favouriteSet().has(channel.id);

  const groups = createMemo<GroupEntry[]>(() => {
    const parsed = playlist();
    if (!parsed) return [];
    const counts = new Map<string, number>();
    for (const channel of parsed.channels) {
      for (const group of channel.groups) counts.set(group, (counts.get(group) ?? 0) + 1);
    }
    const entries: GroupEntry[] = [
      { id: ALL_GROUP, label: "All channels", count: parsed.channels.length, pinned: true },
      { id: FAVOURITES_GROUP, label: "Favourites", count: favouriteSet().size, pinned: true },
    ];
    for (const group of parsed.groups) {
      entries.push({ id: group, label: group, count: counts.get(group) ?? 0 });
    }
    return entries;
  });

  const visibleChannels = createMemo<readonly Channel[]>(() => {
    const query = searchQuery().trim().toLowerCase();
    let list = allChannels();

    if (query.length > 0) {
      // Search spans the whole playlist, not the current group — searching
      // inside a filter is a common frustration.
      return list.filter((c) => c.name.toLowerCase().includes(query));
    }

    const group = groupId();
    if (group === FAVOURITES_GROUP) {
      const favourites = favouriteSet();
      return list.filter((c) => favourites.has(c.id));
    }
    if (group !== ALL_GROUP) {
      list = list.filter((c) => c.groups.includes(group));
    }
    return list;
  });

  const currentChannel = (): Channel | undefined => visibleChannels()[selected()];
  const playingChannel = createMemo(() => {
    const id = playingId();
    return id ? allChannels().find((c) => c.id === id) : undefined;
  });

  const getNowNext = (channel: Channel): NowNext => {
    if (!channel.tvgId) return {};
    const schedule = epg.get(channel.tvgId);
    if (!schedule) return {};
    return nowAndNext(schedule, nowSeconds());
  };

  const playingNowNext = createMemo<NowNext>(() => {
    const channel = playingChannel();
    return channel ? getNowNext(channel) : {};
  });

  /**
   * Wall-clock position of what is on screen.
   *
   * During catchup this cannot be read back from the player: webOS does not
   * expose EXT-X-PROGRAM-DATE-TIME to the app. So it is reconstructed from the
   * timestamp we asked the server for plus elapsed media time — which is why
   * `PlaybackSession.startedAt` is recorded at request time.
   */
  const playbackClock = createMemo(() => {
    const current = session();
    if (current?.mode === "catchup" && current.startedAt !== undefined) {
      return current.startedAt + mediaTime();
    }
    return nowSeconds();
  });

  /** The programme being watched — pinned during catchup, live otherwise. */
  const activeProgramme = createMemo<Programme | undefined>(() => {
    const current = session();
    if (current?.mode === "catchup") return current.programme;
    return playingNowNext().now;
  });

  // --- lifecycle ----------------------------------------------------------

  onMount(() => {
    player = new WebOSPlayer(videoHost, setStatus);
    const removeHandler = installRemoteHandler(handleKey);

    // One timer for the whole UI: wall clock and media position together, so
    // progress bars across every row update in lockstep rather than each row
    // owning a timer.
    const clock = window.setInterval(() => {
      setNowSeconds(Math.floor(Date.now() / 1000));
      setMediaTime(player?.currentTime() ?? 0);
    }, 1000);
    void boot();

    onCleanup(() => {
      removeHandler();
      window.clearInterval(clock);
      if (infoTimer !== undefined) window.clearTimeout(infoTimer);
      if (toastTimer !== undefined) window.clearTimeout(toastTimer);
      if (controlsTimer !== undefined) window.clearTimeout(controlsTimer);
      if (seekCommitTimer !== undefined) window.clearTimeout(seekCommitTimer);
      epg.terminate();
      player?.dispose();
      player = null;
    });
  });

  async function boot(): Promise<void> {
    // Cached guide first so the list is never blank while the network runs.
    void epg.loadFromCache();
    await loadPlaylist();
  }

  async function loadPlaylist(): Promise<void> {
    setScreen("loading");
    try {
      const url = settings().playlistUrl || PLAYLIST_URL;
      if (!url) throw new Error("No playlist URL configured. Set VITE_PLAYLIST_URL in .env.local");

      const response = await fetch(url);
      if (!response.ok) throw new Error(`Playlist request failed: HTTP ${response.status}`);
      const text = await response.text();

      // Classify before parsing so a login page or an EPG file yields a real
      // explanation rather than "0 channels".
      const detection = detectFormat(text);
      if (detection.format === "html") {
        throw new Error("That URL returned a web page, not a playlist. Wrong link, or a login is required?");
      }
      if (detection.format === "xmltv") {
        throw new Error("That URL is an XMLTV guide file, not a channel playlist.");
      }

      const parsed = parseM3u(text);
      if (parsed.channels.length === 0) {
        throw new Error(`No channels found (detected format: ${detection.format})`);
      }

      console.info(
        `[playlist] ${parsed.channels.length} channels, ${parsed.groups.length} groups, ` +
          `${parsed.issues.length} issues`,
      );

      batch(() => {
        setPlaylist(parsed);
        setScreen("browse");
        restoreLastChannel(parsed);
      });

      void maybeRefreshEpg(parsed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[playlist] load failed:", message);
      setErrorText(message);
      setScreen("error");
    }
  }

  function restoreLastChannel(parsed: Playlist): void {
    const lastId = settings().lastChannelId;
    if (!lastId) return;
    const index = parsed.channels.findIndex((c) => c.id === lastId);
    if (index >= 0) setSelected(index);
  }

  async function maybeRefreshEpg(parsed: Playlist): Promise<void> {
    const url = parsed.header.epgUrls[0];
    if (!url) return;

    const current = settings();
    const age = current.epgUpdatedAt ? Date.now() - current.epgUpdatedAt : Number.POSITIVE_INFINITY;
    const sameSource = current.epgUrl === url;
    if (sameSource && age < EPG_MAX_AGE_MS && epg.channelCount > 0) {
      console.info(`[epg] cache is ${(age / 3600000).toFixed(1)}h old; skipping refresh`);
      return;
    }

    const ids = parsed.channels.map((c) => c.tvgId).filter((id) => id.length > 0);
    await epg.refresh(url, ids);
    if (epg.channelCount > 0) {
      updateSettings({ epgUpdatedAt: Date.now(), epgUrl: url });
    }
  }

  function updateSettings(patch: Partial<Settings>): void {
    setSettings((previous) => {
      const merged = { ...previous, ...patch };
      saveSettings(merged);
      return merged;
    });
  }

  // --- input --------------------------------------------------------------

  function handleKey(event: RemoteEvent): boolean {
    if (searching()) return handleSearchKey(event);
    switch (screen()) {
      case "error":
        if (event.key === "ok") {
          void loadPlaylist();
          return true;
        }
        return false;
      case "browse":
        return handleBrowseKey(event);
      case "watch":
        return handleWatchKey(event);
      case "guide":
        return handleGuideKey(event);
      default:
        return false;
    }
  }

  // --- guide --------------------------------------------------------------

  function openGuide(): void {
    const list = visibleChannels();
    if (list.length === 0) return;

    // Seed the cursor on whatever is playing (or selected) at the current time,
    // so the guide opens where the user's attention already is.
    const anchorId = playingId() ?? currentChannel()?.id;
    const channelIndex = Math.max(0, list.findIndex((c) => c.id === anchorId));
    const nowS = Math.floor(Date.now() / 1000);

    batch(() => {
      setGuideWindowStart(alignToHalfHour(nowS - 1800));
      setGuideSelection({
        channelIndex,
        programme: programmeCursorFor(list[channelIndex], nowS),
      });
      setScreen("guide");
    });
  }

  function programmeCursorFor(channel: Channel | undefined, time: number): Programme | null {
    if (!channel?.tvgId) return null;
    const schedule = epg.get(channel.tvgId);
    if (!schedule) return null;
    return firstProgrammeFrom(schedule, time) ?? null;
  }

  function handleGuideKey(event: RemoteEvent): boolean {
    const list = visibleChannels();
    const selection = guideSelection();

    switch (event.key) {
      case "up":
      case "down": {
        const delta = event.key === "up" ? -1 : 1;
        const nextIndex = Math.min(list.length - 1, Math.max(0, selection.channelIndex + delta));
        // Hold the time position while moving between channels, and land on
        // whatever is airing then — moving vertically should not also move you
        // through time.
        const anchor = selection.programme?.start ?? nowSeconds();
        setGuideSelection({
          channelIndex: nextIndex,
          programme: programmeCursorFor(list[nextIndex], anchor),
        });
        return true;
      }
      case "channelUp":
      case "channelDown": {
        const delta = event.key === "channelUp" ? -5 : 5;
        const nextIndex = Math.min(list.length - 1, Math.max(0, selection.channelIndex + delta));
        const anchor = selection.programme?.start ?? nowSeconds();
        setGuideSelection({
          channelIndex: nextIndex,
          programme: programmeCursorFor(list[nextIndex], anchor),
        });
        return true;
      }
      case "left":
      case "right": {
        const direction = event.key === "left" ? -1 : 1;
        const channel = list[selection.channelIndex];
        if (!channel?.tvgId) return true;
        const schedule = epg.get(channel.tvgId);
        if (!schedule) return true;

        const from = selection.programme?.start ?? nowSeconds();
        const next = adjacentProgramme(schedule, from, direction);
        if (!next) return true;

        setGuideSelection({ channelIndex: selection.channelIndex, programme: next });
        ensureVisible(next);
        return true;
      }
      case "ok": {
        const channel = list[selection.channelIndex];
        if (!channel) return true;
        const programme = selection.programme;
        const nowS = Math.floor(Date.now() / 1000);

        if (!programme || (programme.start <= nowS && programme.stop > nowS)) {
          playLive(channel);
          setScreen("watch");
          return true;
        }
        if (programme.start > nowS) {
          showToast("That programme has not aired yet");
          return true;
        }
        if (!isWithinArchive(channel.catchup, programme.start, nowS)) {
          showToast(
            channel.catchup && channel.catchup.days > 0
              ? `Outside the ${channel.catchup.days}-day archive`
              : "No archive on this channel",
          );
          return true;
        }
        playCatchup(channel, programme);
        return true;
      }
      case "back":
      case "green":
        setScreen(playingId() ? "watch" : "browse");
        return true;
      case "red":
        toggleFavouriteFor(list[selection.channelIndex]);
        return true;
      default:
        return false;
    }
  }

  /** Slide the guide window so the cursor stays on screen. */
  function ensureVisible(programme: Programme): void {
    const start = guideWindowStart();
    const end = start + GUIDE_WINDOW_MINUTES * 60;
    if (programme.start < start) {
      setGuideWindowStart(alignToHalfHour(programme.start));
    } else if (programme.stop > end) {
      // Park the selection about a third in, so there is visible context ahead.
      setGuideWindowStart(alignToHalfHour(programme.start - GUIDE_WINDOW_MINUTES * 60 * 0.33));
    }
  }

  function handleSearchKey(event: RemoteEvent): boolean {
    if (event.key === "back") {
      closeSearch();
      return true;
    }
    if (event.key === "ok") {
      setSearching(false);
      searchInput?.blur();
      setColumn("list");
      return true;
    }
    // Everything else belongs to the text field and its on-screen keyboard.
    return false;
  }

  function handleBrowseKey(event: RemoteEvent): boolean {
    switch (event.key) {
      case "left":
        setColumn("sidebar");
        return true;
      case "right":
        setColumn("list");
        return true;
      case "up":
        moveSelection(-1);
        return true;
      case "down":
        moveSelection(1);
        return true;
      case "channelUp":
        moveSelection(-10);
        return true;
      case "channelDown":
        moveSelection(10);
        return true;
      case "ok":
        if (column() === "sidebar") {
          setColumn("list");
          return true;
        }
        startWatching();
        return true;
      case "back":
        // Only close the panel if something is already playing; otherwise let
        // webOS exit, which is what users expect from the top-level screen.
        if (playingId()) {
          setScreen("watch");
          return true;
        }
        return false;
      case "red":
        toggleFavourite();
        return true;
      case "green":
        openGuide();
        return true;
      case "yellow":
        openSearch();
        return true;
      case "blue":
        setColumn("sidebar");
        return true;
      default:
        return false;
    }
  }

  function handleWatchKey(event: RemoteEvent): boolean {
    switch (event.key) {
      case "back":
        // Back dismisses the controls first, so it is an undo rather than an
        // exit when the user has them open.
        if (showControls()) {
          setShowControls(false);
          setSeekTarget(null);
          return true;
        }
        setScreen("browse");
        syncSelectionToPlaying();
        return true;
      case "ok":
        // OK opens transport controls rather than jumping to the channel list;
        // while watching, the likely intent is to control playback.
        if (showControls()) {
          togglePause();
        } else {
          revealControls();
        }
        return true;
      case "up":
      case "channelUp":
        zap(-1);
        return true;
      case "down":
      case "channelDown":
        zap(1);
        return true;
      case "left":
        nudgeSeek(-30);
        return true;
      case "right":
        nudgeSeek(30);
        return true;
      case "rewind":
        nudgeSeek(-300);
        return true;
      case "forward":
        nudgeSeek(300);
        return true;
      case "stop":
        jumpToLive();
        return true;
      case "blue":
        jumpToLive();
        return true;
      case "info":
        revealInfo();
        return true;
      case "playpause":
      case "pause":
      case "play":
        togglePause();
        return true;
      case "red":
        toggleFavourite();
        revealInfo();
        return true;
      case "green":
        openGuide();
        return true;
      case "yellow":
        setScreen("browse");
        openSearch();
        return true;
      default:
        return false;
    }
  }

  function moveSelection(delta: number): void {
    if (column() === "sidebar") {
      const list = groups();
      if (list.length === 0) return;
      const index = list.findIndex((g) => g.id === groupId());
      const nextIndex = Math.min(list.length - 1, Math.max(0, index + Math.sign(delta)));
      batch(() => {
        setGroupId(list[nextIndex]!.id);
        setSelected(0);
      });
      return;
    }
    const total = visibleChannels().length;
    if (total === 0) return;
    // Single steps wrap (endless zapping feels right); jumps clamp, so CH+ at
    // the bottom does not teleport to the top.
    if (Math.abs(delta) === 1) setSelected((i) => (i + delta + total) % total);
    else setSelected((i) => Math.min(total - 1, Math.max(0, i + delta)));
  }

  function syncSelectionToPlaying(): void {
    const id = playingId();
    if (!id) return;
    const index = visibleChannels().findIndex((c) => c.id === id);
    if (index >= 0) setSelected(index);
  }

  // --- playback -----------------------------------------------------------

  function startWatching(): void {
    const channel = currentChannel();
    if (!channel) return;
    playLive(channel);
    setScreen("watch");
  }

  function playLive(channel: Channel): void {
    batch(() => {
      setSession({ channelId: channel.id, mode: "live" });
      // Any pending pause or scrub belongs to the previous stream.
      setPaused(false);
      setSeekTarget(null);
      setMediaTime(0);
    });
    pausedAtWallClock = null;
    updateSettings({ lastChannelId: channel.id });
    revealInfo();
    player?.play(channel.url);
  }

  /**
   * Play an archived programme.
   *
   * The URL form is derived by `buildCatchupUrl`, verified against this
   * provider: `?utc=&lutc=`. Two other conventions return HTTP 200 while
   * silently serving the live edge, so the archive window is checked up front
   * and a refusal is reported rather than quietly playing the wrong thing.
   */
  function playCatchup(channel: Channel, programme: Programme): void {
    try {
      const nowS = Math.floor(Date.now() / 1000);
      const url = buildCatchupUrl({
        channel,
        startSeconds: programme.start,
        durationSeconds: programme.stop - programme.start,
        nowSeconds: nowS,
      });
      batch(() => {
        setSession({
          channelId: channel.id,
          mode: "catchup",
          programme,
          startedAt: programme.start,
        });
        setPaused(false);
        setSeekTarget(null);
        setMediaTime(0);
        setScreen("watch");
      });
      pausedAtWallClock = null;
      updateSettings({ lastChannelId: channel.id });
      revealInfo();
      player?.play(url);
    } catch (error) {
      if (error instanceof CatchupUnavailableError) {
        showToast(
          error.reason === "outside-window"
            ? `Outside the ${channel.catchup?.days ?? 0}-day archive`
            : error.reason === "in-future"
              ? "That programme has not aired yet"
              : "No archive on this channel",
        );
        return;
      }
      showToast("Could not start playback");
      console.warn("[catchup] failed:", error);
    }
  }

  function zap(delta: number): void {
    const list = visibleChannels();
    if (list.length === 0) return;
    const currentIndex = Math.max(
      0,
      list.findIndex((c) => c.id === playingId()),
    );
    const nextIndex = (currentIndex + delta + list.length) % list.length;
    const channel = list[nextIndex];
    if (!channel) return;

    setSelected(nextIndex);
    // Zapping always returns to live — carrying a catchup position across a
    // channel change has no meaning.
    playLive(channel);
  }

  // --- transport ----------------------------------------------------------

  /**
   * Seek to a wall-clock moment by re-requesting the stream from there.
   *
   * There is no client-side seek available: a live HLS manifest only exposes a
   * short sliding window, so anything outside it must come from the server.
   * `?utc=` returns a manifest starting at the requested time, which makes
   * "seek" and "start catchup" the same operation.
   */
  function seekToWallClock(targetSeconds: number): void {
    const channel = playingChannel();
    if (!channel) return;

    const nowS = Math.floor(Date.now() / 1000);
    const clamped = clampToArchive(channel.catchup, targetSeconds, nowS);
    if (clamped === null) {
      showToast("This channel has no archive — seeking unavailable");
      return;
    }

    // Landing within the live-edge margin means the user scrubbed to the
    // present; give them the real live stream rather than an archive request
    // for segments that barely exist yet.
    if (clamped >= nowS - 30) {
      jumpToLive();
      return;
    }

    const schedule = channel.tvgId ? epg.get(channel.tvgId) : undefined;
    const programme = schedule ? programmeAt(schedule, clamped) : undefined;

    try {
      const url = buildCatchupUrl({
        channel,
        startSeconds: clamped,
        durationSeconds: programme ? programme.stop - clamped : 3600,
        nowSeconds: nowS,
      });
      const next: PlaybackSession = programme
        ? { channelId: channel.id, mode: "catchup", programme, startedAt: clamped }
        : { channelId: channel.id, mode: "catchup", startedAt: clamped };
      batch(() => {
        setSession(next);
        setPaused(false);
        setMediaTime(0);
      });
      player?.play(url);
    } catch (error) {
      if (error instanceof CatchupUnavailableError) {
        showToast(
          error.reason === "outside-window"
            ? `Outside the ${channel.catchup?.days ?? 0}-day archive`
            : "Cannot seek there",
        );
        return;
      }
      showToast("Seek failed");
      console.warn("[seek] failed:", error);
    }
  }

  function jumpToLive(): void {
    const channel = playingChannel();
    if (!channel) return;
    setPaused(false);
    playLive(channel);
    showToast("Live");
  }

  /**
   * Move the scrub cursor without committing.
   *
   * Each committed seek re-requests the stream, and this provider allows only
   * two concurrent connections, so holding ◀ must not fire a request per
   * keypress. The cursor moves immediately for feedback; the seek lands after
   * a short pause in input.
   */
  function nudgeSeek(deltaSeconds: number): void {
    const channel = playingChannel();
    if (!channel) return;
    if (!archiveRange(channel.catchup, Math.floor(Date.now() / 1000))) {
      showToast("This channel has no archive — seeking unavailable");
      return;
    }

    revealControls();
    const base = seekTarget() ?? playbackClock();
    const nowS = Math.floor(Date.now() / 1000);
    const clamped = clampToArchive(channel.catchup, base + deltaSeconds, nowS);
    if (clamped === null) return;
    setSeekTarget(clamped);

    if (seekCommitTimer !== undefined) window.clearTimeout(seekCommitTimer);
    seekCommitTimer = window.setTimeout(() => {
      const target = seekTarget();
      setSeekTarget(null);
      if (target !== null) seekToWallClock(target);
    }, 900);
  }

  /**
   * Pause, with timeshift when the channel supports it.
   *
   * On a live stream, pausing and resuming normally snaps back to the live
   * edge — the buffered window has moved on. Since this provider has a 7-day
   * archive, we record the wall-clock moment of the pause and resume from it,
   * which is what "pause live TV" means to a viewer.
   */
  function togglePause(): void {
    const channel = playingChannel();
    if (!channel) return;
    revealControls();

    if (!paused()) {
      pausedAtWallClock = playbackClock();
      setPaused(true);
      player?.togglePause();
      return;
    }

    setPaused(false);
    const current = session();
    const canTimeshift = archiveRange(channel.catchup, Math.floor(Date.now() / 1000)) !== null;

    // Resuming a live stream after a pause of any length: re-request from the
    // paused moment so the viewer continues where they stopped.
    if (current?.mode === "live" && canTimeshift && pausedAtWallClock !== null) {
      const behind = Math.floor(Date.now() / 1000) - pausedAtWallClock;
      if (behind > 10) {
        seekToWallClock(pausedAtWallClock);
        showToast(`Resumed ${Math.round(behind / 60)} min behind live`);
        pausedAtWallClock = null;
        return;
      }
    }
    // Archive playback pauses and resumes normally — the segments stay put.
    player?.togglePause();
    pausedAtWallClock = null;
  }

  function revealControls(): void {
    setShowControls(true);
    setShowInfo(false);
    if (controlsTimer !== undefined) window.clearTimeout(controlsTimer);
    controlsTimer = window.setTimeout(() => {
      setShowControls(false);
      setSeekTarget(null);
    }, 6000);
  }

  function showToast(message: string): void {
    setToast(message);
    if (toastTimer !== undefined) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => setToast(""), 3000);
  }

  function toggleFavourite(): void {
    toggleFavouriteFor(screen() === "watch" ? playingChannel() : currentChannel());
  }

  function toggleFavouriteFor(channel: Channel | undefined): void {
    if (!channel) return;
    const current = settings().favourites;
    const isOn = current.includes(channel.id);
    updateSettings({
      favourites: isOn ? current.filter((id) => id !== channel.id) : [...current, channel.id],
    });
    showToast(isOn ? `Removed ${channel.name}` : `Added ${channel.name} to favourites`);
  }

  function revealInfo(): void {
    setShowInfo(true);
    if (infoTimer !== undefined) window.clearTimeout(infoTimer);
    infoTimer = window.setTimeout(() => setShowInfo(false), 5000);
  }

  function openSearch(): void {
    batch(() => {
      setSearching(true);
      setScreen("browse");
    });
    // Focusing a real <input> is what makes webOS raise its on-screen keyboard.
    queueMicrotask(() => searchInput?.focus());
  }

  function closeSearch(): void {
    batch(() => {
      setSearching(false);
      setSearchQuery("");
      setSelected(0);
    });
    searchInput?.blur();
  }

  // --- render -------------------------------------------------------------

  return (
    <div class="app">
      {/* Mounted at all times: creating and destroying the element per channel
          change is a reliable way to leak decoder handles on webOS. */}
      <div class="video-host" ref={videoHost} classList={{ active: playingId() !== null }} />
      <div class="scrim" classList={{ active: screen() === "browse" }} />

      <Show when={screen() === "loading"}>
        <div class="centred">
          <div class="spinner" />
          <p>Loading playlist…</p>
        </div>
      </Show>

      <Show when={screen() === "error"}>
        <div class="centred error">
          <h1>Could not load the playlist</h1>
          <p class="error-detail">{errorText()}</p>
          <p class="hint">Press OK to retry</p>
        </div>
      </Show>

      <Show when={screen() === "browse" && playlist()}>
        <div class="browse">
          <header class="browse-header">
            <div class="browse-title">
              {searchQuery() ? `Search: ${searchQuery()}` : currentGroupLabel()}
              <span class="browse-count">{visibleChannels().length}</span>
            </div>
            <EpgStatus progress={epgProgress()} />
          </header>

          <div class="browse-body">
            <Sidebar
              groups={groups()}
              selectedId={groupId()}
              focused={column() === "sidebar"}
              onSelect={(id) => {
                batch(() => {
                  setGroupId(id);
                  setSelected(0);
                  setColumn("list");
                });
              }}
            />

            <div class="browse-main">
              <Show when={searching()}>
                <input
                  class="search-input"
                  ref={searchInput}
                  value={searchQuery()}
                  placeholder="Search channels…"
                  onInput={(e) => {
                    setSearchQuery(e.currentTarget.value);
                    setSelected(0);
                  }}
                />
              </Show>

              <Show
                when={visibleChannels().length > 0}
                fallback={<div class="empty">Nothing here yet.</div>}
              >
                <ChannelList
                  channels={visibleChannels()}
                  selectedIndex={selected()}
                  viewportHeight={searching() ? LIST_VIEWPORT - 96 : LIST_VIEWPORT}
                  focused={column() === "list" && !searching()}
                  nowSeconds={nowSeconds()}
                  getNowNext={getNowNext}
                  isFavourite={isFavourite}
                  onActivate={(index) => {
                    setSelected(index);
                    startWatching();
                  }}
                />
              </Show>
            </div>
          </div>

          <footer class="browse-footer">
            <Legend colour="red" text="Favourite" />
            <Legend colour="green" text="Guide" />
            <Legend colour="yellow" text="Search" />
            <Legend colour="blue" text="Groups" />
            <span class="legend-plain">OK Watch · ◀▶ Columns · CH± Jump 10</span>
          </footer>
        </div>
      </Show>

      <Show when={screen() === "guide" && playlist()}>
        <div class="guide-screen">
          <header class="browse-header">
            <div class="browse-title">
              TV Guide
              <span class="browse-count">{visibleChannels().length} channels</span>
            </div>
            <EpgStatus progress={epgProgress()} />
          </header>

          <Guide
            channels={visibleChannels()}
            selection={guideSelection()}
            windowStart={guideWindowStart()}
            windowMinutes={GUIDE_WINDOW_MINUTES}
            viewportHeight={GUIDE_VIEWPORT}
            nowSeconds={nowSeconds()}
            getSchedule={(channel) => (channel.tvgId ? epg.get(channel.tvgId) : undefined)}
            isFavourite={isFavourite}
            onActivate={(channelIndex, programme) => {
              setGuideSelection({ channelIndex, programme });
              handleGuideKey({ key: "ok" } as RemoteEvent);
            }}
          />

          <footer class="browse-footer">
            <Legend colour="red" text="Favourite" />
            <Legend colour="green" text="Close" />
            <span class="legend-plain">
              OK Watch or replay · ◀▶ Programme · ▲▼ Channel · ⟲ = in archive
            </span>
          </footer>
        </div>
      </Show>

      <Show when={screen() === "watch" && showControls()}>
        <PlayerControls
          channel={playingChannel()}
          programme={activeProgramme()}
          position={playbackClock()}
          seekTarget={seekTarget()}
          paused={paused()}
          live={session()?.mode === "live"}
          seekDisabled={archiveRange(playingChannel()?.catchup, nowSeconds()) === null}
          nowSeconds={nowSeconds()}
        />
      </Show>

      <Show when={screen() === "watch" && showInfo() && !showControls()}>
        <InfoBar
          channel={playingChannel()}
          channelNumber={playingChannel()?.channelNumber ?? selected() + 1}
          now={activeProgramme()}
          next={session()?.mode === "catchup" ? undefined : playingNowNext().next}
          nowSeconds={playbackClock()}
          status={status()}
          catchup={session()?.mode === "catchup"}
        />
      </Show>

      <Show when={toast()}>
        <div class="toast">{toast()}</div>
      </Show>
    </div>
  );

  function currentGroupLabel(): string {
    const id = groupId();
    const entry = groups().find((g) => g.id === id);
    return entry?.label ?? "Channels";
  }
}

/** Round down to the previous half hour — guide windows start on :00 or :30. */
function alignToHalfHour(epochSeconds: number): number {
  return Math.floor(epochSeconds / 1800) * 1800;
}

function Legend(props: { colour: string; text: string }) {
  return (
    <span class="legend">
      <span class={`legend-dot ${props.colour}`} />
      {props.text}
    </span>
  );
}

function EpgStatus(props: { progress: EpgProgress }) {
  return (
    <Show when={props.progress.state !== "idle"}>
      <div class="epg-status">
        <Show when={props.progress.state === "loading"}>
          <span class="spinner tiny" />
          <span>Guide {props.progress.programmes.toLocaleString()} programmes…</span>
        </Show>
        <Show when={props.progress.state === "ready"}>
          <span>Guide · {props.progress.programmes.toLocaleString()} programmes</span>
        </Show>
        <Show when={props.progress.state === "error"}>
          <span class="epg-error">Guide unavailable</span>
        </Show>
      </div>
    </Show>
  );
}
