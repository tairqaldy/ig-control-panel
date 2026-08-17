/**
 * Instagram Profile Score (ROUND7-SPEC §4). Mounted at /api/profile with one line in ./extra.ts.
 *
 *   GET  /api/profile/questions          → { questions, goals, subject } — five prefilled questions
 *   POST /api/profile/goals  {goal,…}    → { goals }
 *   GET  /api/profile/score              → ProfileScorePayload (latest report, previous, delta) — free, no model call
 *   POST /api/profile/score {manual?,goals?} → ProfileScorePayload — costs 1 credit on the `ask` metric
 *
 * The POST works for a tenant with no Instagram connection: `manual` carries `{ username, name, bio, link }` and is
 * remembered, so a re-score needs no second paste. Nothing here returns a bare 500 — an OpenAI outage comes back as
 * 200 with the previous report and `stale: true`, and a tenant with no report at all gets a 503 that explains itself.
 */
import { Hono } from 'hono';
import { tid } from '../auth.js';
import { checkQuota, quotaResponse } from '../services/plans.js';
import {
  GOAL_FIELDS, profileQuestions, runProfileScore, saveGoals, scorePayload,
  type GoalField, type RunOptions,
} from '../services/profile-score.js';

export const profileScore = new Hono();

profileScore.get('/questions', (c) => c.json(profileQuestions(tid(c))));

profileScore.post('/goals', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const patch: Partial<Record<GoalField, string | null>> = {};
  for (const f of GOAL_FIELDS) {
    if (!(f in body)) continue;
    const v = body[f];
    patch[f] = v === null || v === undefined || v === '' ? null : String(v);
  }
  return c.json({ goals: saveGoals(tid(c), patch) });
});

profileScore.get('/score', (c) => c.json(scorePayload(tid(c))));

profileScore.post('/score', async (c) => {
  const t = tid(c);
  const body = await c.req.json<{ manual?: RunOptions['manual']; goals?: Record<string, unknown> }>().catch(() => ({} as any));

  // The check runs before the model call so an out-of-allowance tenant sees the upgrade/buy-credits modal, not a
  // half-finished report. The credit itself is taken afterwards, once there is something to charge for.
  const q = checkQuota(t, 'ask', 1);
  // `ask` also carries a per-minute rate limit, which is not an allowance problem: somebody who just sent a few Ask
  // messages was being shown "buy credits" for something no purchase can fix. Say wait, and say how long.
  if (!q.ok && q.window === 'minute') {
    const retryAfter = Math.max(1, (q.resetsAt || 0) - Math.floor(Date.now() / 1000)) || 60;
    c.header('retry-after', String(retryAfter));
    return c.json({ error: `You have asked a lot in the last minute. Scoring is available again in ${retryAfter} second${retryAfter === 1 ? '' : 's'}.`, code: 'rate_limited', retryAfter }, 429);
  }
  if (!q.ok) return quotaResponse(c, q, t);

  const goals: Partial<Record<GoalField, string | null>> = {};
  if (body.goals && typeof body.goals === 'object') {
    for (const f of GOAL_FIELDS) {
      if (!(f in body.goals)) continue;
      const v = (body.goals as Record<string, unknown>)[f];
      goals[f] = v === null || v === undefined || v === '' ? null : String(v);
    }
  }

  const out = await runProfileScore(t, {
    manual: body.manual && typeof body.manual === 'object' ? body.manual : null,
    goals: Object.keys(goals).length ? goals : null,
  });

  switch (out.status) {
    case 'ok':
      return c.json(out.payload);
    case 'stale':
      return c.json({ ...out.payload, message: out.message });
    case 'rate_limited':
      c.header('retry-after', String(out.retryAfter));
      return c.json({ ...out.payload, error: out.message, code: 'rate_limited', retryAfter: out.retryAfter }, 429);
    case 'needs_profile':
      return c.json({ ...out.payload, error: out.message, code: 'profile_required' }, 400);
    case 'unavailable':
      return c.json({ ...out.payload, error: out.message, code: 'ai_unavailable' }, 503);
  }
});
