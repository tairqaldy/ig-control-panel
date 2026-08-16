/* Type declarations for harvester/core.js (hand-written; keep in sync when you change core.js). */

export const IG_ORIGIN: string;
export const IG_APP_ID: string;
export const HARVEST_FORMAT: string;
export const HARVEST_VERSION: number;
export const SAVED_FEED_PATH: string;
export const COLLECTIONS_LIST_PATH: string;
export function collectionFeedPath(collectionId: string | number): string;
export function userInfoPath(userId: string | number): string;
export function savedFeedUrl(maxId?: string, origin?: string): string;
export function collectionFeedUrl(collectionId: string | number, maxId?: string, origin?: string): string;
export function collectionsListUrl(maxId?: string, origin?: string): string;
export function userInfoUrl(userId: string | number, origin?: string): string;

export interface HeaderOpts {
  sessionid?: string;
  csrftoken?: string;
  dsUserId?: string;
  ua?: string;
  referer?: string;
  username?: string;
}
export function buildHeaders(opts?: HeaderOpts): Record<string, string>;

export function pageItems(data: unknown): any[];
export function pageCursor(data: unknown): { more: boolean; nextMaxId: string };
export function parseCollectionsPage(cl: unknown): { total: number | null; collections: Array<{ id: string; name: string; count: number }>; nextMaxId: string };
export function pickImg(iv2: unknown): { url: string; width?: number; height?: number } | null;
export function pickVideo(vv: unknown): { url: string; width?: number; height?: number } | null;
export function musicOf(m: any): { title: string; artist: string } | null;
export function originalAudio(m: any): string | null;

/** Returns a HarvestItem-shaped object (see server/src/types.ts). Throws on unreadable input. */
export function normalizeItem(node: any, ctx?: { collections?: string[] | null } | null): any;
export function buildHarvestPayload(input?: { account?: unknown; collections?: unknown[]; items?: unknown[] }): { format: string; version: number; exported_at: number; account: unknown; collections: unknown[]; items: unknown[] };
export function pageDelayMs(min?: number, spread?: number): number;
export function looksLikeLoginPage(status: number, contentType?: string | null, text?: string | null): boolean;
export function looksLikeLoggedOut(res: { status: number; url?: string; redirected?: boolean; headers?: { get(name: string): string | null } } | null | undefined, text?: string | null): boolean;
export function parseFeedPage(data: unknown, ctx?: { collections?: string[] | null } | null): { items: any[]; moreAvailable: boolean; nextMaxId: string; rawCount: number };
