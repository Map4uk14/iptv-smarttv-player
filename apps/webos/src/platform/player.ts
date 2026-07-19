/**
 * webOS media playback.
 *
 * Playback goes through the TV's native pipeline (hardware decode). We do NOT
 * ship hls.js: on this hardware, demuxing HLS in JavaScript means software
 * decode and a slideshow. LG's docs state HLS is supported natively, selected
 * via a `mediaOption` blob encoded into the <source> `type` attribute.
 *
 * ---------------------------------------------------------------------------
 * UNVERIFIED ON DEVICE. LG's own example shows `video/mp4;mediaOption=...`,
 * which is odd for HLS, and other documentation uses the HLS MIME types. I
 * could not resolve which the TV actually accepts from documentation alone, so
 * this tries them in order and reports which succeeded. The first on-device run
 * is what settles it — after that, collapse this to the winning strategy.
 * ---------------------------------------------------------------------------
 *
 * Also note: `max-conn="2"` in the sample playlist caps concurrent streams, and
 * webOS does not expose EXT-X-PROGRAM-DATE-TIME to the app. Hence the single
 * owned element with explicit teardown, and the app-side clock for catchup.
 */

export interface MediaOption {
  mediaTransportType: "HLS" | "URI";
  option?: {
    adaptiveStreaming?: {
      audioOnly?: boolean;
      adaptiveResolution?: boolean;
      seamlessPlay?: boolean;
      maxWidth?: number;
      maxHeight?: number;
      bps?: { start?: number };
    };
  };
}

export type PlaybackState = "idle" | "loading" | "playing" | "paused" | "error";

export interface PlaybackStatus {
  readonly state: PlaybackState;
  readonly message?: string;
  /** Which source strategy actually worked — logged for the on-device test. */
  readonly strategy?: string;
}

interface SourceStrategy {
  readonly name: string;
  readonly type: string | null;
}

function buildMediaOption(): string {
  const options: MediaOption = {
    mediaTransportType: "HLS",
    option: {
      adaptiveStreaming: {
        audioOnly: false,
        adaptiveResolution: true,
        seamlessPlay: true,
        maxWidth: 1920,
        maxHeight: 1080,
      },
    },
  };
  return encodeURI(JSON.stringify(options));
}

function strategies(): SourceStrategy[] {
  const mediaOption = buildMediaOption();
  return [
    // LG's documented HLS MIME with the mediaOption blob attached.
    { name: "hls-mime+mediaOption", type: `application/vnd.apple.mpegurl;mediaOption=${mediaOption}` },
    // The form used verbatim in LG's own mediaOption example.
    { name: "mp4-mime+mediaOption", type: `video/mp4;mediaOption=${mediaOption}` },
    // Plain HLS MIME, letting the platform sniff the transport.
    { name: "hls-mime", type: "application/vnd.apple.mpegurl" },
    // Last resort: assign src directly and let the TV work it out.
    { name: "bare-src", type: null },
  ];
}

/**
 * Whether the platform can demux HLS itself. True on webOS and Safari, false in
 * desktop Chrome — which is exactly the signal the dev fallback keys off.
 */
export function supportsNativeHls(): boolean {
  const probe = document.createElement("video");
  return (
    probe.canPlayType("application/vnd.apple.mpegurl") !== "" ||
    probe.canPlayType("application/x-mpegURL") !== ""
  );
}

interface DevHls {
  destroy(): void;
}

export class WebOSPlayer {
  private readonly video: HTMLVideoElement;
  private readonly onStatus: (status: PlaybackStatus) => void;
  private strategyIndex = 0;
  private currentUrl: string | null = null;
  private disposed = false;
  private devHls: DevHls | null = null;

  constructor(container: HTMLElement, onStatus: (status: PlaybackStatus) => void) {
    this.onStatus = onStatus;

    const video = document.createElement("video");
    video.autoplay = true;
    video.setAttribute("playsinline", "");
    video.style.cssText = "position:absolute;inset:0;width:100%;height:100%;background:#000;object-fit:contain";
    container.appendChild(video);
    this.video = video;

    video.addEventListener("loadstart", () => this.emit("loading"));
    video.addEventListener("playing", () => this.emit("playing"));
    video.addEventListener("pause", () => this.emit("paused"));
    video.addEventListener("error", () => this.handleError());
  }

  private emit(state: PlaybackState, message?: string): void {
    if (this.disposed) return;
    const status: { state: PlaybackState; message?: string; strategy?: string } = { state };
    if (message !== undefined) status.message = message;
    const strategy = strategies()[this.strategyIndex];
    if (strategy) status.strategy = strategy.name;
    this.onStatus(status);
  }

  /**
   * Play a stream. Any previous stream is torn down first — the provider caps
   * concurrent connections, so overlapping streams would burn the allowance
   * and start failing with no obvious cause.
   */
  play(url: string): void {
    this.stop();
    this.currentUrl = url;
    this.strategyIndex = 0;

    // Desktop Chrome cannot play HLS natively, so during development we fall
    // back to hls.js purely so the app is testable without a TV.
    //
    // This branch is compiled out of production builds: Vite substitutes
    // `import.meta.env.DEV` with `false` and the minifier drops the dead code,
    // so hls.js never reaches the TV. That matters — shipping a JS demuxer to
    // webOS would mean software decode and destroy playback performance.
    // There is a build assertion for this; see scripts/check-bundle.mjs.
    if (import.meta.env.DEV && !supportsNativeHls()) {
      void this.attachDevFallback(url);
      return;
    }

    this.attach();
  }

  /** Development only. Never present in a production bundle. */
  private async attachDevFallback(url: string): Promise<void> {
    this.emit("loading", "dev: hls.js (browser only)");
    try {
      const { default: Hls } = await import("hls.js");
      if (this.disposed || this.currentUrl !== url) return;

      if (!Hls.isSupported()) {
        this.emit("error", "dev: hls.js unsupported in this browser");
        return;
      }
      const hls = new Hls({ enableWorker: true, lowLatencyMode: false });
      this.devHls = hls;
      hls.loadSource(url);
      hls.attachMedia(this.video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        void this.video.play().catch(() => undefined);
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) this.emit("error", `dev: hls.js ${data.type} / ${data.details}`);
      });
    } catch (error) {
      this.emit("error", `dev: hls.js failed to load (${String(error)})`);
    }
  }

  private attach(): void {
    const strategy = strategies()[this.strategyIndex];
    const url = this.currentUrl;
    if (!strategy || !url) return;

    // Clear any previous <source> children before re-attaching.
    while (this.video.firstChild) this.video.removeChild(this.video.firstChild);

    if (strategy.type === null) {
      this.video.src = url;
    } else {
      const source = document.createElement("source");
      source.setAttribute("src", url);
      source.setAttribute("type", strategy.type);
      this.video.appendChild(source);
      this.video.removeAttribute("src");
    }

    this.emit("loading", `trying ${strategy.name}`);
    this.video.load();
    const attempt = this.video.play();
    if (attempt && typeof attempt.catch === "function") {
      // Autoplay rejection is expected in a desktop browser; on the TV it
      // usually means the source was refused, which `error` also reports.
      attempt.catch(() => undefined);
    }
  }

  /**
   * On failure, fall through to the next source strategy rather than giving up.
   * This is what turns "black screen, no explanation" into a usable diagnosis.
   */
  private handleError(): void {
    if (this.disposed || !this.currentUrl) return;

    const failed = strategies()[this.strategyIndex];
    const mediaError = this.video.error;
    const detail = mediaError ? `code ${mediaError.code}` : "unknown error";
    console.warn(`[player] strategy "${failed?.name}" failed (${detail})`);

    if (this.strategyIndex < strategies().length - 1) {
      this.strategyIndex++;
      this.attach();
      return;
    }

    this.emit("error", `all playback strategies failed (last: ${detail})`);
  }

  /**
   * Elapsed media time in seconds.
   *
   * During catchup this is the only position signal available: webOS does not
   * surface EXT-X-PROGRAM-DATE-TIME, so the app adds this to the timestamp it
   * requested to reconstruct the wall-clock position.
   */
  currentTime(): number {
    const t = this.video.currentTime;
    return Number.isFinite(t) ? t : 0;
  }

  togglePause(): void {
    if (this.video.paused) void this.video.play();
    else this.video.pause();
  }

  stop(): void {
    // Tear the dev demuxer down first — it holds its own segment connections,
    // which would otherwise survive a channel change and eat the provider's
    // 2-connection allowance.
    if (this.devHls) {
      this.devHls.destroy();
      this.devHls = null;
    }
    this.video.pause();
    while (this.video.firstChild) this.video.removeChild(this.video.firstChild);
    this.video.removeAttribute("src");
    // Forces the pipeline to release the connection immediately rather than
    // when the element is eventually collected.
    this.video.load();
    this.currentUrl = null;
  }

  dispose(): void {
    this.stop();
    this.disposed = true;
    this.video.remove();
  }
}
