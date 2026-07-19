/**
 * webOS remote control key mapping.
 *
 * The TV remote reports plain `keydown` events, but with codes that differ
 * from a desktop keyboard in ways that matter:
 *
 *  - **Back is 461**, not Escape. If it is not handled *and* the default is
 *    not prevented, webOS closes the app. That single omission is why so many
 *    TV apps exit when you meant to go up one level.
 *  - Channel Up/Down arrive as PageUp/PageDown (33/34).
 *  - The coloured buttons are 403–406 and are the conventional shortcut row on
 *    TV, so they are first-class here rather than an afterthought.
 *
 * Desktop equivalents are included so the whole UI is drivable in a browser
 * during development without a TV attached.
 */

export type RemoteKey =
  | "up"
  | "down"
  | "left"
  | "right"
  | "ok"
  | "back"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "play"
  | "pause"
  | "playpause"
  | "stop"
  | "rewind"
  | "forward"
  | "channelUp"
  | "channelDown"
  | "info"
  | "digit";

const KEY_CODES: Record<number, RemoteKey> = {
  37: "left",
  38: "up",
  39: "right",
  40: "down",
  13: "ok",
  461: "back", // webOS Back — NOT Escape
  27: "back", // Escape, for desktop development
  8: "back", // Backspace, for desktop development
  403: "red",
  404: "green",
  405: "yellow",
  406: "blue",
  415: "play",
  19: "pause",
  10252: "playpause", // media play/pause on some remotes
  413: "stop",
  412: "rewind",
  417: "forward",
  33: "channelUp", // PageUp
  34: "channelDown", // PageDown
  457: "info",
};

export interface RemoteEvent {
  readonly key: RemoteKey;
  /** For "digit": the numeral pressed, 0–9. */
  readonly digit?: number;
  readonly original: KeyboardEvent;
}

export function mapKeyEvent(event: KeyboardEvent): RemoteEvent | null {
  const code = event.keyCode || event.which;

  if (code >= 48 && code <= 57) {
    return { key: "digit", digit: code - 48, original: event };
  }
  // Numeric keypad, for desktop development.
  if (code >= 96 && code <= 105) {
    return { key: "digit", digit: code - 96, original: event };
  }

  const key = KEY_CODES[code];
  return key ? { key, original: event } : null;
}

export type RemoteHandler = (event: RemoteEvent) => boolean | void;

/**
 * Install a global remote listener.
 *
 * The handler returns `true` when it consumed the key. Anything consumed gets
 * `preventDefault()` — critical for Back, since letting it through closes the
 * app. Returning falsy lets the platform have the key, which is how the user
 * exits from the top-level screen.
 */
export function installRemoteHandler(handler: RemoteHandler): () => void {
  const listener = (event: KeyboardEvent): void => {
    const mapped = mapKeyEvent(event);
    if (!mapped) return;
    if (handler(mapped) === true) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  window.addEventListener("keydown", listener, true);
  return () => window.removeEventListener("keydown", listener, true);
}
