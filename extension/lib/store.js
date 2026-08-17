/*
 * Resurfly Companion — chrome.storage.local wrapper + the single place that knows the keys.
 *
 * Keys (all in chrome.storage.local):
 *   appUrl            string   origin of the Resurfly app (default DEFAULT_APP_URL)
 *   token             string   device token 'cmp_…' (absent = not paired)
 *   tenantId          number
 *   deviceName        string
 *   pairedAt          number   epoch ms
 *   serverHarvest     boolean  user opted in to server-side harvesting
 *   firstRunDone      boolean  the initial full walk of the saved feed finished
 *   walk              object   in-progress (resumable) walk of the saved feed, or absent:
 *                              { cursor: string (max_id of the next page), runId: number|null,
 *                                imported: number, newItems: number, pages: number, startedAt: ms, full: boolean }
 *   lastSyncAt        number   epoch ms of the last finished attempt
 *   lastSyncStatus    string   'ok' | 'login_required' | 'quota' | 'unpaired' | 'error' | 'partial'
 *   lastSyncError     string   human message for 'error'
 *   lastSyncNew       number   new items the last run produced
 *   lastSyncImported  number
 *   total             number   server-side total items (from /state)
 *   lastHarvestAt     number   epoch s from /state (any source)
 *   harvestQuota      object   { used, limit, resetsAt } from /state
 *   serverHarvestStatus string 'ok' | 'invalid' | null — server's view of the stored session
 *   serverHarvestAvailable boolean  false when the server runs with SERVER_HARVEST_ENABLED=false (toggle disabled)
 *   minIntervalMinutes number  from /state (default 360) — alarm-triggered syncs closer than this are skipped
 *   syncing           number   epoch ms lock while a sync runs (stale after 15 min)
 *   badgeUntil        number   epoch ms when the numeric badge should clear
 *   newLog            array    [{ at: ms, n: number }] one entry per sync that found saves, pruned to 7 days —
 *                              the popup's "N new since yesterday" line sums the last 24 h
 */

export const DEFAULT_APP_URL = 'https://resurfly.com';

export const KEYS = [
  'appUrl', 'token', 'tenantId', 'deviceName', 'pairedAt', 'serverHarvest',
  'firstRunDone', 'walk',
  'lastSyncAt', 'lastSyncStatus', 'lastSyncError', 'lastSyncNew', 'lastSyncImported',
  'total', 'lastHarvestAt', 'harvestQuota', 'serverHarvestStatus', 'serverHarvestAvailable', 'minIntervalMinutes', 'syncing', 'badgeUntil', 'newLog',
];

export async function getAll() {
  const v = await chrome.storage.local.get(KEYS);
  if (!v.appUrl) v.appUrl = DEFAULT_APP_URL;
  return v;
}

export function get(keys) {
  return chrome.storage.local.get(keys);
}

export function set(obj) {
  return chrome.storage.local.set(obj);
}

export function remove(keys) {
  return chrome.storage.local.remove(keys);
}

/** Forget the pairing but keep the app URL (and nothing about the account). */
export async function clearPairing() {
  await chrome.storage.local.remove(KEYS.filter((k) => k !== 'appUrl'));
}

/** Origin pattern for chrome.permissions ('https://host/*'). */
export function originPattern(appUrl) {
  try {
    const u = new URL(appUrl);
    return `${u.protocol}//${u.host}/*`;
  } catch (e) {
    return null;
  }
}
