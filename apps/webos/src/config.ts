/**
 * The playlist URL is a credential — it embeds a subscription token — so it is
 * read from an environment file that is git-ignored, never committed inline.
 * See .env.example. A settings screen replaces this in a later milestone.
 */
export const PLAYLIST_URL: string = import.meta.env["VITE_PLAYLIST_URL"] ?? "";
