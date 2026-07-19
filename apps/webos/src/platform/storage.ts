/**
 * Persistence.
 *
 * Two tiers, chosen for the constraints measured in ARCHITECTURE.md:
 *
 *  - **localStorage** for settings and favourites. Capped at 16 MB on webOS
 *    3.5+, synchronous, and available before the first paint — which is what
 *    makes a fast startup possible (we can render the last-used channel list
 *    ordering without waiting on IndexedDB).
 *  - **IndexedDB** for EPG schedules, one record per channel. Typed arrays go
 *    through structured clone without serialisation, so a store or load is
 *    close to a memcpy rather than a JSON parse.
 *
 * Packaged webOS apps lose their data on update or uninstall, so everything
 * here is treated as a **disposable cache**: if a read fails or returns
 * nothing, the app refetches. Nothing is ever the source of truth.
 */

import type { ChannelSchedule } from "../../../../packages/core/src/epg/schedule.ts";

const DB_NAME = "iptv";
const DB_VERSION = 1;
const STORE_EPG = "epg";
const STORE_META = "meta";

const SETTINGS_KEY = "iptv.settings.v1";

export interface Settings {
  playlistUrl: string;
  favourites: string[];
  lastChannelId: string | null;
  /** Epoch ms of the last successful EPG index build. */
  epgUpdatedAt: number | null;
  epgUrl: string | null;
}

const DEFAULT_SETTINGS: Settings = {
  playlistUrl: "",
  favourites: [],
  lastChannelId: null,
  epgUpdatedAt: null,
  epgUrl: null,
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    // Merge over defaults so a settings blob written by an older build cannot
    // leave a field undefined and crash a screen.
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (error) {
    // Quota or private-mode failures must never break playback.
    console.warn("[storage] could not persist settings:", error);
  }
}

// --------------------------------------------------------------------------

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_EPG)) db.createObjectStore(STORE_EPG);
      if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  if (!dbPromise) dbPromise = openDatabase();
  return dbPromise;
}

/**
 * Persist all channel schedules.
 *
 * One record per channel, so the guide can later load only the rows it is about
 * to draw instead of the whole index.
 */
export async function saveSchedules(schedules: Map<string, ChannelSchedule>): Promise<void> {
  const database = await db();
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction(STORE_EPG, "readwrite");
    const store = tx.objectStore(STORE_EPG);
    store.clear();
    for (const [id, schedule] of schedules) store.put(schedule, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function loadAllSchedules(): Promise<Map<string, ChannelSchedule>> {
  const result = new Map<string, ChannelSchedule>();
  try {
    const database = await db();
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(STORE_EPG, "readonly");
      const store = tx.objectStore(STORE_EPG);
      const cursorRequest = store.openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) {
          resolve();
          return;
        }
        result.set(String(cursor.key), cursor.value as ChannelSchedule);
        cursor.continue();
      };
      cursorRequest.onerror = () => reject(cursorRequest.error);
      tx.onerror = () => reject(tx.error);
    });
  } catch (error) {
    // A cache miss is not an error condition — the caller refetches.
    console.warn("[storage] EPG cache unavailable:", error);
  }
  return result;
}

export async function clearSchedules(): Promise<void> {
  try {
    const database = await db();
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(STORE_EPG, "readwrite");
      tx.objectStore(STORE_EPG).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (error) {
    console.warn("[storage] could not clear EPG cache:", error);
  }
}
