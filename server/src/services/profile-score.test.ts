/**
 * In-process test for the Instagram Profile Score (ROUND7-SPEC §4). No test runner, no ports, no network:
 * the OpenAI Responses API is mocked on globalThis.fetch and the app is driven with `app.request`.
 *
 *   npx tsx server/src/services/profile-score.test.ts
 *
 * The tenant here has NO Instagram connection on purpose — that is the path most people are on while our Meta app is
 * not Live, and the one the feature has to work on. Covers: migration 010; prefilled questions; the manual-paste run;
 * the report shape (five dimensions, three bios inside Instagram's 150 characters, three next actions); the credit
 * charge; the 10-minute re-score limit; and the OpenAI outage returning the cached report with `stale: true`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resurfly-profile-'));
process.env.DATA_DIR = dir;
process.env.NODE_ENV = 'test';
process.env.HOSTED = 'true';
process.env.AUTO_START_WORKER = 'false';
process.env.SERVER_HARVEST_ENABLED = 'false';
process.env.APP_USERNAME = 'owner@example.com';
process.env.SESSION_SECRET = 'test-session-secret-value-0123456789';
process.env.OPENAI_API_KEY = 'sk-test-0123456789abcdef';
process.env.META_APP_ID = '';
process.env.META_APP_SECRET = '';

/* ---------- OpenAI mock ---------- */
type ModelMode = 'ok' | 'quota' | 'broken' | 'empty' | 'slow';
const mock = { mode: 'ok' as ModelMode, calls: 0, lastPrompt: '' };

const REPLY = {
  overall: 62,
  headline: 'The topic is clear; the bio never says who it is for.',
  name_handle: { score: 70, verdict: 'The handle is easy to spell, the Name field carries no topic.', fixes: [{ what: 'Put "sourdough" in the Name field.', why: 'Instagram searches the Name field.', effort: 'minute', example: 'Alex — sourdough' }] },
  bio: { score: 48, verdict: 'It says what you like, not what a follower gets.', fixes: [{ what: 'Open the bio with who it is for.', why: 'A beginner should recognise themselves in line one.', effort: 'hour', example: null }] },
  photo: { score: 60, verdict: 'Could not see the picture.', fixes: [{ what: 'Check the crop at 40 pixels.', why: 'Most people see it small.', effort: 'minute', example: null }] },
  positioning: { score: 55, verdict: 'Two topics compete for the same 150 characters.', fixes: [{ what: 'Drop the second topic.', why: 'One promise is easier to follow.', effort: 'project', example: null }] },
  settings: { score: 66, verdict: 'No contact button and one link.', fixes: [{ what: 'Turn on the e-mail contact button.', why: 'It is how a first enquiry arrives.', effort: 'minute', example: null }] },
  bio_rewrites: [
    { text: 'Sourdough for people with a day job. Two loaves a week, no starter drama. Recipes below.', angle: 'who it is for' },
    { text: 'I bake sourdough after work and write down what actually worked. 300+ loaves in.', angle: 'proof first' },
    // deliberately over 150 characters: the server must fit it to Instagram's limit instead of shipping it as is
    { text: `Weeknight sourdough, no fuss. ${'x'.repeat(200)}`, angle: 'call to action' },
  ],
  next_three: [
    { what: 'Put "sourdough" in the Name field.', why: 'It makes you findable in search.', effort: 'minute', example: 'Alex — sourdough' },
    { what: 'Rewrite line one of the bio.', why: 'It is the only line most people read.', effort: 'hour', example: null },
    { what: 'Turn on the e-mail contact button.', why: 'Enquiries stop getting lost in DMs.', effort: 'minute', example: null },
  ],
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input instanceof URL ? input.href : typeof input === 'string' ? input : input?.url || '');
  if (!/\/responses\b/.test(url)) return json({ data: [] });
  mock.calls++;
  try { mock.lastPrompt = JSON.parse(String(init?.body || '{}')).instructions + '\n' + JSON.stringify(JSON.parse(String(init?.body || '{}')).input); } catch { mock.lastPrompt = ''; }
  if (mock.mode === 'quota') {
    // 400, not 429: the SDK retries a 429 four times and this test should not wait for the backoff.
    return json({ error: { type: 'insufficient_quota', code: 'insufficient_quota', message: 'You exceeded your current quota, please check your plan and billing details.' } }, 400);
  }
  if (mock.mode === 'broken') return json({ error: { type: 'server_error', message: 'upstream exploded' } }, 400);
  if (mock.mode === 'empty') {
    // Valid JSON, no report. `strict: true` makes this unlikely against the real API, but OPENAI_BASE_URL can point
    // the key at a gateway that ignores json_schema — and clampScore turns every missing field into a real 0.
    const blank = JSON.stringify({});
    return json({ id: 'resp_blank', object: 'response', status: 'completed', output_text: blank, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: blank }] }], usage: { input_tokens: 10, output_tokens: 2 } });
  }
  if (mock.mode === 'slow') {
    // Longer than the run's own deadline: without one, the SDK's 4 retries × 3 minutes outlive the browser and the
    // proxy, and "cached report, never a 500" becomes a connection the person watches die.
    await new Promise((r) => setTimeout(r, 3000));
    return json({ error: { type: 'server_error', message: 'too late' } }, 400);
  }
  const text = JSON.stringify(REPLY);
  return json({ id: 'resp_test', object: 'response', status: 'completed', output_text: text, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 900, output_tokens: 700 } });
}) as typeof fetch;

/* ---------- harness ---------- */
let failures = 0;
function check(name: string, cond: unknown, detail?: unknown) {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
}
const eq = (name: string, actual: unknown, expected: unknown) => check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
const section = (s: string) => console.log(`\n=== ${s} ===`);

async function main() {
  const { createApp } = await import('../app.js');
  const { db, now } = await import('../db.js');
  const { createSessionToken } = await import('../auth.js');
  const { addCredits, creditBalance } = await import('./credits.js');
  const { PLANS, planPayload } = await import('./plans.js');
  const ps = await import('./profile-score.js');
  const { _clearQuotaBlock } = await import('./openai.js');

  const d = db();
  const ts = now();
  const mk = (email: string) => {
    const tid = Number(d.prepare("INSERT INTO tenants (name, plan, plan_status, created_at, updated_at) VALUES ('profile test', 'pro', 'active', ?, ?)").run(ts, ts).lastInsertRowid);
    const uid = Number(d.prepare('INSERT INTO users (tenant_id, email, password_hash, is_owner, created_at) VALUES (?, ?, NULL, 0, ?)').run(tid, email, ts).lastInsertRowid);
    return { tid, cookie: `rs_session=${createSessionToken(email, tid, uid)}` };
  };
  const me = mk(`profile-${ts}@example.com`);
  const stranger = mk(`profile-empty-${ts}@example.com`);

  const app = createApp();
  const get = (p: string, cookie = me.cookie) => app.request(p, { headers: { cookie } });
  const post = (p: string, body?: unknown, cookie = me.cookie) =>
    app.request(p, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

  /* ---------------- migration ---------------- */
  section('migration 010');
  const tables = (d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('profile_goals','profile_scores')").all() as Array<{ name: string }>).map((r) => r.name).sort();
  eq('both tables exist', tables, ['profile_goals', 'profile_scores']);
  check('scores are indexed by (tenant_id, id)', !!d.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name = 'idx_profile_scores_tenant'").get());

  /* ---------------- questions ---------------- */
  section('questions');
  // two analyzed saves so the niche question can offer a category the person will recognise
  for (const [i, cat] of ['cooking', 'cooking'].entries()) {
    d.prepare(`INSERT INTO items (id, url, tenant_id, media_type, analysis_status, analysis, created_at, updated_at, saved_at)
      VALUES (?, ?, ?, 'video', 'done', ?, ?, ?, ?)`)
      .run(`itm-${ts}-${i}`, `https://instagram.com/p/x${i}`, me.tid, JSON.stringify({ category: cat, usefulness_score: 7 }), ts, ts, ts);
  }
  const qs = await (await get('/api/profile/questions')).json();
  eq('five questions in order', qs.questions.map((q: any) => q.id), ['goal', 'niche', 'audience', 'offer', 'tone']);
  check('every question allows a free-text answer', qs.questions.every((q: any) => q.allowOther && typeof q.placeholder === 'string' && q.placeholder.length > 0), qs.questions.map((q: any) => q.placeholder));
  const niche = qs.questions.find((q: any) => q.id === 'niche');
  eq('niche is prefilled from their saved categories', [niche.prefill, niche.options[0]?.value], ['cooking', 'cooking']);
  check('and it says where the suggestion came from', /2 saves/.test(String(niche.prefillFrom)), niche.prefillFrom);
  eq('nothing is connected', [qs.connected, qs.subject.connected, qs.subject.source], [false, false, 'none']);
  const offerQ = qs.questions.find((q: any) => q.id === 'offer');
  eq('nothing is guessed about a bio we have never seen', [offerQ.prefill, offerQ.prefillFrom], [null, null]);
  check('and a guess is labelled as a guess', /^a guess from the topic you save most/.test(String(qs.questions.find((q: any) => q.id === 'audience').prefillFrom)), qs.questions.find((q: any) => q.id === 'audience').prefillFrom);

  /* ---------------- goals ---------------- */
  section('goals');
  const saved = await (await post('/api/profile/goals', { goal: 'business', niche: 'sourdough', audience: 'beginners', offer: 'services', tone: 'direct' })).json();
  eq('answers come back', [saved.goals.goal, saved.goals.niche, saved.goals.tone], ['business', 'sourdough', 'direct']);
  eq('and they persist', ps.getGoals(me.tid)?.niche, 'sourdough');

  /* ---------------- score with no Instagram connection ---------------- */
  section('score from a pasted profile (no Instagram connection)');
  const before = planPayload(me.tid).usage.ask.used;
  const res = await post('/api/profile/score', { manual: { username: '@alexbakes', name: 'Alex', bio: 'baker. cyclist. dad.\nlondon', link: 'https://alexbakes.com' } });
  const body = await res.json();
  eq('200', res.status, 200);
  eq('overall is a 0-100 integer', [body.score.overall, Number.isInteger(body.score.overall)], [62, true]);
  eq('five dimensions', Object.keys(body.score.report.dimensions).sort(), ['bio', 'name_handle', 'photo', 'positioning', 'settings']);
  check('each dimension has a verdict and 1-3 fixes', Object.values(body.score.report.dimensions).every((dim: any) => dim.verdict && dim.fixes.length >= 1 && dim.fixes.length <= 3));
  check('every fix declares an effort we understand', Object.values(body.score.report.dimensions).every((dim: any) => dim.fixes.every((f: any) => ['minute', 'hour', 'project'].includes(f.effort))));
  eq('three next actions, in order', body.score.report.nextThree.length, 3);
  eq('three bio rewrites', body.score.report.bioRewrites.length, 3);
  check('none of them exceeds Instagram\'s 150 characters', body.score.report.bioRewrites.every((b: any) => [...b.text].length <= 150), body.score.report.bioRewrites.map((b: any) => b.length));
  check('the over-long rewrite was fitted, not shipped raw', body.score.report.bioRewrites[2].text.length <= 150 && body.score.report.bioRewrites[2].text.startsWith('Weeknight sourdough'), body.score.report.bioRewrites[2]);
  eq('the paste is what was scored', [body.subject.source, body.subject.username, body.subject.link], ['manual', 'alexbakes', 'https://alexbakes.com']);
  eq('a paste is not a connection', [body.connected, body.subject.manual], [false, true]);
  check('the report says what it could not check', body.score.report.notChecked.some((s: string) => /posting cadence/.test(s)), body.score.report.notChecked);
  check('the report remembers the goals it was written against', body.score.report.goals.niche === 'sourdough', body.score.report.goals);
  eq('no previous score yet, so no delta', [body.previous, body.delta], [null, null]);
  eq('one ask unit was charged', planPayload(me.tid).usage.ask.used, before + 1);
  eq('it cost one credit-equivalent', body.cost, { credits: 1, metric: 'ask' });

  section('the prompt only carries measured facts');
  check('the bio reaches the model verbatim', /baker\. cyclist\. dad\./.test(mock.lastPrompt));
  check('and it is told the cadence is unknown', /WHAT THEY POST: not available/.test(mock.lastPrompt));
  check('and told never to invent a number', /Never invent a number/.test(mock.lastPrompt));
  check('and never to tell them to connect Instagram', /Never tell the person to connect Instagram/.test(mock.lastPrompt));

  /* ---------------- rate limit ---------------- */
  section('re-scoring is limited to once per 10 minutes');
  const again = await post('/api/profile/score');
  const againBody = await again.json();
  eq('429', again.status, 429);
  eq('with a code the UI can branch on', againBody.code, 'rate_limited');
  check('and a retry-after inside ten minutes', againBody.retryAfter > 0 && againBody.retryAfter <= 600, againBody.retryAfter);
  check('and the time the next run is allowed', againBody.retryAt > Math.floor(Date.now() / 1000), againBody.retryAt);
  check('the existing report still comes back', againBody.score?.overall === 62, againBody.score?.overall);
  eq('and nothing more was charged', planPayload(me.tid).usage.ask.used, before + 1);
  eq('the model was called once', mock.calls, 1);

  /* ---------------- a second run: delta + credits ---------------- */
  section('a second run pays from credits once the allowance is gone');
  d.prepare('INSERT INTO usage (tenant_id, period, metric, count) VALUES (?, ?, ?, ?) ON CONFLICT(tenant_id, period, metric) DO UPDATE SET count = excluded.count')
    .run(me.tid, new Date().toISOString().slice(0, 7), 'ask', PLANS.pro.askPerMonth);
  addCredits(me.tid, 3, 'grant', 'profile-test-grant');
  REPLY.overall = 71;
  const second = await ps.runProfileScore(me.tid, { ignoreCooldown: true });
  eq('it ran', second.status, 'ok');
  eq('one credit was spent', creditBalance(me.tid), 2);
  eq('and the run reports the charge', second.payload.charged, { creditsSpent: 1, balance: 2, ok: true });

  const latest = await (await get('/api/profile/score')).json();
  eq('the newest report is the one we get back', latest.score.overall, 71);
  eq('with the previous one to compare against', latest.previous.overall, 62);
  eq('and the delta', latest.delta, 9);
  eq('reading the score costs nothing', mock.calls, 2);

  /* ---------------- OpenAI unavailable ---------------- */
  section('OpenAI unavailable → the cached report, marked stale');
  mock.mode = 'quota';
  const balanceBefore = creditBalance(me.tid);
  const stale = await ps.runProfileScore(me.tid, { ignoreCooldown: true });
  eq('status', stale.status, 'stale');
  eq('the last report comes back', stale.payload.score?.overall, 71);
  eq('flagged as stale', stale.payload.stale, true);
  check('with a reason a person can read', /try again in a few minutes/i.test(String(stale.payload.staleReason)), stale.payload.staleReason);
  eq('nothing was charged', creditBalance(me.tid), balanceBefore);
  eq('and no row was added', (d.prepare('SELECT COUNT(*) AS n FROM profile_scores WHERE tenant_id = ?').get(me.tid) as any).n, 2);

  section('a tenant with no report at all gets an honest 503, not a 500');
  const fresh = await post('/api/profile/score', { manual: { username: 'nobody', bio: 'hello' } }, stranger.cookie);
  const freshBody = await fresh.json();
  eq('503', fresh.status, 503);
  eq('code', freshBody.code, 'ai_unavailable');
  check('and it explains itself', String(freshBody.error).length > 20, freshBody.error);
  eq('still nothing charged', planPayload(stranger.tid).usage.ask.used, 0);
  mock.mode = 'ok';

  /* ---------------- fix pass: two tabs must not buy two reports ---------------- */
  section('one run at a time per tenant');
  {
    mock.mode = 'ok';
    // The outage section above tripped the shared OpenAI quota breaker; forget it, or every run below skips the
    // model and answers `stale` — which is the breaker working, not the thing under test here.
    _clearQuotaBlock();
    const callsBefore = mock.calls;
    const creditsBefore = creditBalance(me.tid);
    const rowsBefore = (d.prepare('SELECT COUNT(*) AS n FROM profile_scores WHERE tenant_id = ?').get(me.tid) as any).n as number;
    // The 10-minute cooldown reads the newest stored row, which is written ~15 s after the model call starts, so it
    // was never a concurrency guard: two tabs, or a double tap that beat the re-render, ran twice, charged twice and
    // left two rows seconds apart — so the next report's "delta" compared a profile against itself.
    const [a, b] = await Promise.all([
      ps.runProfileScore(me.tid, { ignoreCooldown: true }),
      ps.runProfileScore(me.tid, { ignoreCooldown: true }),
    ]);
    const statuses = [a.status, b.status].sort();
    eq('one runs, the other is turned away', statuses, ['ok', 'rate_limited']);
    eq('the model was called once', mock.calls - callsBefore, 1);
    eq('one credit, not two', creditsBefore - creditBalance(me.tid), 1);
    eq('and one new row', (d.prepare('SELECT COUNT(*) AS n FROM profile_scores WHERE tenant_id = ?').get(me.tid) as any).n - rowsBefore, 1);
  }

  /* ---------------- fix pass: an empty answer is not a 0/100 report ---------------- */
  section('a response with no report is never stored as a score');
  {
    mock.mode = 'empty';
    const rowsBefore = (d.prepare('SELECT COUNT(*) AS n FROM profile_scores WHERE tenant_id = ?').get(me.tid) as any).n as number;
    const creditsBefore = creditBalance(me.tid);
    const usedBefore = planPayload(me.tid).usage.ask.used;
    const out = await ps.runProfileScore(me.tid, { ignoreCooldown: true });
    eq('it falls back to the last real report', out.status, 'stale');
    eq('no new row', (d.prepare('SELECT COUNT(*) AS n FROM profile_scores WHERE tenant_id = ?').get(me.tid) as any).n, rowsBefore);
    eq('nothing charged', [creditBalance(me.tid), planPayload(me.tid).usage.ask.used], [creditsBefore, usedBefore]);
    check('and the newest score is still a real one', ((await (await get('/api/profile/score')).json()) as any).score.overall > 0);
    mock.mode = 'ok';
  }

  /* ---------------- fix pass: the model call is bounded ---------------- */
  section('a hanging model call gives back the cached report, not a dead connection');
  {
    mock.mode = 'slow';
    const started = Date.now();
    const out = await ps.runProfileScore(me.tid, { ignoreCooldown: true });
    const took = Date.now() - started;
    eq('the cached report comes back', out.status, 'stale');
    check(`and it did not wait for the SDK to give up (${took} ms)`, took < 60_000, took);
    mock.mode = 'ok';
  }

  /* ---------------- fix pass: a handle without a bio is not scoreable ---------------- */
  section('a bio is required, because the schema forces a bio score either way');
  {
    // canScore used to accept a handle alone. With a connection there is always a handle and never a bio (the
    // Instagram Login API does not return one), so a connected tenant went straight into a charged run whose report
    // said "the bio text was not checked" next to a number for the bio.
    const handleOnly = mk(`profile-handle-${ts}@example.com`);
    const r = await post('/api/profile/score', { manual: { username: 'alex_bakes' } }, handleOnly.cookie);
    const body = await r.json() as any;
    eq('400, and it says which field', [r.status, body.code], [400, 'profile_required']);
    check('naming the bio', /bio/i.test(String(body.error)), body.error);
    eq('nothing was charged', planPayload(handleOnly.tid).usage.ask.used, 0);
    // The client's paste form now enables submit on exactly this rule, so the two agree.
    check('a name alone is not enough either', !ps.canScore(ps.profileSubject(handleOnly.tid)));
    const withBio = await post('/api/profile/score', { manual: { bio: 'Sourdough for people with a day job.' } }, handleOnly.cookie);
    eq('handle plus bio runs', withBio.status, 200);
  }

  /* ---------------- fix pass: bio rewrites are never cut mid-word ---------------- */
  section('a rewrite that cannot break on a word is marked, not sliced through a token');
  {
    const latest = await (await get('/api/profile/score')).json() as any;
    for (const r of latest.score.report.bioRewrites as Array<{ text: string; length: number }>) {
      check(`"${r.text.slice(0, 24)}…" fits Instagram's 150 characters`, [...r.text].length <= 150, r.length);
      const truncatedMidToken = /[^\s…]$/.test(r.text) && r.text.includes('xxxxxxxxxx');
      check('and is not a token cut in half', !truncatedMidToken, r.text.slice(-40));
    }
  }

  /* ---------------- nothing to score ---------------- */
  section('nothing to score');
  d.prepare("DELETE FROM meta WHERE tenant_id = ? AND key = 'profile_manual'").run(stranger.tid);
  const nothing = await post('/api/profile/score', {}, stranger.cookie);
  const nothingBody = await nothing.json();
  eq('400 with a code the UI can branch on', [nothing.status, nothingBody.code], [400, 'profile_required']);
  check('and it asks for exactly what is missing', /paste your instagram handle/i.test(String(nothingBody.error)), nothingBody.error);
  eq('canScore says so too', nothingBody.canScore, false);

  console.log(failures ? `\n${failures} failure(s)\n` : '\nall good\n');
  if (failures) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
