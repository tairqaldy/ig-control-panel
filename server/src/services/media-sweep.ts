/**
 * Orphaned-media sweep (ROUND7 fix pass, §7).
 *
 * `DELETE /api/account` answers as soon as the rows are gone and removes the cached thumbnails and extracted video
 * frames afterwards, because a ten-thousand-item library takes a while. A redeploy or a crash in the middle of that
 * loop used to leave the files on disk with no row left to find them by — while `/privacy` and `/data-deletion` both
 * state the disk cache goes with the account. This finishes the job: every folder under the media directory is named
 * after an item id, so anything that maps to no live item is residue.
 *
 * Deliberately conservative: it only ever removes directories the media layer itself created, and a failure to read
 * the directory is a no-op rather than an error.
 */
import { db } from '../db.js';
import { sweepOrphanMedia } from './media.js';

const DAY_MS = 24 * 3600_000;
/** Long enough for the background loop of a just-finished delete to be over before we look. */
const FIRST_RUN_MS = 60_000;

function liveItemIds(): string[] {
  try { return (db().prepare('SELECT id FROM items').all() as Array<{ id: string }>).map((r) => r.id); } catch { return []; }
}

let started = false;

export function startMediaSweep(): void {
  if (started) return;
  started = true;
  const run = () => { void sweepOrphanMedia(liveItemIds).catch((e) => console.warn('[media] sweep failed', e?.message || e)); };
  setTimeout(run, FIRST_RUN_MS).unref?.();
  setInterval(run, DAY_MS).unref?.();
}
