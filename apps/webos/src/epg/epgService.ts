/**
 * Main-thread front end for the EPG worker.
 *
 * Policy lives here rather than in the worker: when a refresh is worth doing,
 * what to show while it runs, and how to fall back. The cache is served
 * immediately on startup so the guide is populated before any network work
 * begins — a cold fetch is ~6s and must never gate first paint.
 */

import type { ChannelSchedule } from "../../../../packages/core/src/epg/schedule.ts";
import type { EpgRequest, EpgResponse, EpgDoneStats } from "./epgWorker.ts";
import { loadAllSchedules, saveSchedules } from "../platform/storage.ts";
// Inlined as a blob rather than emitted as a sibling file. Off a file:// origin
// a worker loaded by URL is rejected outright ("cannot be accessed from origin
// 'null'"), and the URL Vite generates for it is wrong under an IIFE build
// anyway — `import.meta.url` resolves to the document, so the assets/ prefix is
// lost. A blob carries no origin check and no path.
import EpgWorker from "./epgWorker.ts?worker&inline";

export interface EpgProgress {
  state: "idle" | "loading" | "ready" | "error";
  /** Programmes indexed so far, for a progress readout. */
  programmes: number;
  message?: string;
}

/** Refresh at most this often — the EPG covers ~22 days and barely changes. */
export const EPG_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours

export class EpgService {
  private schedules = new Map<string, ChannelSchedule>();
  private worker: Worker | null = null;
  private onProgress: (progress: EpgProgress) => void;

  constructor(onProgress: (progress: EpgProgress) => void) {
    this.onProgress = onProgress;
  }

  get(channelId: string): ChannelSchedule | undefined {
    return this.schedules.get(channelId);
  }

  get channelCount(): number {
    return this.schedules.size;
  }

  /** Serve the cached index. Fast, and safe to call before any network work. */
  async loadFromCache(): Promise<number> {
    this.schedules = await loadAllSchedules();
    if (this.schedules.size > 0) {
      this.onProgress({ state: "ready", programmes: this.programmeCount() });
    }
    return this.schedules.size;
  }

  private programmeCount(): number {
    let total = 0;
    for (const schedule of this.schedules.values()) total += schedule.starts.length;
    return total;
  }

  /**
   * Fetch and index the EPG in a worker.
   *
   * Resolves when the index is live. Failures are reported through
   * `onProgress` and never thrown at the caller — a missing guide degrades the
   * UI, it does not break playback.
   */
  refresh(url: string, channelIds: string[]): Promise<void> {
    return new Promise((resolve) => {
      this.terminate();
      this.onProgress({ state: "loading", programmes: 0 });

      // Construction can still throw on an old webOS build, so the failure is
      // reported like any other EPG failure rather than escaping into an
      // unhandled rejection and leaving the status stuck on "loading".
      let worker: Worker;
      try {
        worker = new EpgWorker();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn("[epg] worker unavailable:", message);
        this.onProgress({
          state: this.schedules.size > 0 ? "ready" : "error",
          programmes: this.programmeCount(),
          message: `guide unavailable: ${message}`,
        });
        resolve();
        return;
      }
      this.worker = worker;

      worker.onmessage = (event: MessageEvent<EpgResponse>) => {
        const message = event.data;
        if (message.type === "progress") {
          this.onProgress({ state: "loading", programmes: message.programmes });
          return;
        }
        if (message.type === "error") {
          console.warn("[epg] refresh failed:", message.message);
          this.onProgress({
            state: this.schedules.size > 0 ? "ready" : "error",
            programmes: this.programmeCount(),
            message: message.message,
          });
          this.terminate();
          resolve();
          return;
        }

        this.schedules = message.schedules;
        this.onProgress({ state: "ready", programmes: this.programmeCount() });
        this.logStats(message.stats);
        this.terminate();
        // Persisting is deliberately not awaited: the guide is already usable,
        // and a slow or failing write must not delay it.
        void saveSchedules(this.schedules).catch((error) =>
          console.warn("[epg] could not cache schedules:", error),
        );
        resolve();
      };

      worker.onerror = (event) => {
        console.warn("[epg] worker error:", event.message);
        this.onProgress({
          state: this.schedules.size > 0 ? "ready" : "error",
          programmes: this.programmeCount(),
          message: event.message,
        });
        this.terminate();
        resolve();
      };

      const request: EpgRequest = { url, channelIds };
      worker.postMessage(request);
    });
  }

  private logStats(stats: EpgDoneStats): void {
    const discarded = stats.programmesSeen - stats.programmesKept;
    console.info(
      `[epg] indexed ${stats.programmesKept.toLocaleString()} programmes across ` +
        `${stats.channelsIndexed} channels in ${(stats.elapsedMs / 1000).toFixed(1)}s ` +
        `(discarded ${discarded.toLocaleString()} for unlisted channels)`,
    );
  }

  terminate(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }
}
