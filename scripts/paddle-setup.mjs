#!/usr/bin/env node
/**
 * Create (or verify) the Resurfly catalog in Paddle — subscriptions + one-time credit packs.
 * Idempotent: matches existing products/prices by custom_data.key and only creates what is missing.
 *
 *   node scripts/paddle-setup.mjs                 # uses PADDLE_API_KEY + PADDLE_ENV from .env
 *   node scripts/paddle-setup.mjs <apiKey> live   # explicit key + environment (sandbox|live)
 *
 * Prints the env lines to paste into Railway at the end. Never prints the API key.
 */
import fs from 'node:fs';

const args = process.argv.slice(2);
const env = Object.fromEntries((fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8') : '').split(/\r?\n/).filter((l) => /^[A-Z_0-9]+=/.test(l)).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
const KEY = args[0] || process.env.PADDLE_API_KEY || env.PADDLE_API_KEY;
const MODE = (args[1] || process.env.PADDLE_ENV || env.PADDLE_ENV || 'sandbox').toLowerCase();
const API = MODE === 'live' || MODE === 'production' ? 'https://api.paddle.com' : 'https://sandbox-api.paddle.com';
if (!KEY) { console.error('No API key. Pass it as the first argument or set PADDLE_API_KEY.'); process.exit(1); }

const H = { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', 'Paddle-Version': '1' };
const call = async (method, path, body) => {
  const r = await fetch(API + path, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} → HTTP ${r.status} ${JSON.stringify(j.error || j).slice(0, 300)}`);
  return j;
};
const list = async (path) => {
  const out = [];
  let url = path;
  for (let i = 0; i < 20 && url; i++) {
    const j = await call('GET', url);
    out.push(...(j.data || []));
    const next = j.meta?.pagination?.has_more ? j.meta.pagination.next : null;
    url = next ? next.replace(API, '') : null;
  }
  return out;
};

/** The catalog. Amounts are in cents. `key` lives in custom_data so re-runs are idempotent. */
const PRODUCTS = [
  { key: 'pro', name: 'Resurfly Pro', description: 'Up to 2,000 saves analyzed, 300 new per month, 300 Ask questions, 10 automation rules, priority queue.' },
  { key: 'studio', name: 'Resurfly Studio', description: 'Up to 10,000 saves analyzed, 2,000 new per month, 1,500 Ask questions, unlimited automation rules, 4x concurrency.' },
  { key: 'credits', name: 'Resurfly credits', description: 'Prepaid credits for analysis, Ask answers and automated replies. 1 credit = 1 save analyzed = 1 Ask answer = 20 automated replies.' },
];

const PRICES = [
  { key: 'pro_month', product: 'pro', name: 'Monthly', description: 'Pro monthly', amount: 1900, interval: 'month' },
  { key: 'pro_year', product: 'pro', name: 'Yearly', description: 'Pro yearly (2 months free)', amount: 14400, interval: 'year' },
  { key: 'studio_month', product: 'studio', name: 'Monthly', description: 'Studio monthly', amount: 4900, interval: 'month' },
  { key: 'studio_year', product: 'studio', name: 'Yearly', description: 'Studio yearly (save 41%)', amount: 34800, interval: 'year' },
  { key: 'credits_500', product: 'credits', name: '500 credits', description: '500 credits', amount: 1200, credits: 500 },
  { key: 'credits_2000', product: 'credits', name: '2,000 credits', description: '2,000 credits', amount: 3900, credits: 2000 },
  { key: 'credits_6000', product: 'credits', name: '6,000 credits', description: '6,000 credits', amount: 9900, credits: 6000 },
];

const ENV_NAME = {
  pro_month: 'PADDLE_PRICE_PRO_MONTH', pro_year: 'PADDLE_PRICE_PRO_YEAR',
  studio_month: 'PADDLE_PRICE_STUDIO_MONTH', studio_year: 'PADDLE_PRICE_STUDIO_YEAR',
  credits_500: 'PADDLE_PRICE_CREDITS_500', credits_2000: 'PADDLE_PRICE_CREDITS_2000', credits_6000: 'PADDLE_PRICE_CREDITS_6000',
};

console.log(`Paddle ${MODE === 'live' || MODE === 'production' ? 'LIVE' : 'sandbox'} (${API})`);

const existingProducts = await list('/products?per_page=100&status=active');
const productId = {};
for (const p of PRODUCTS) {
  const found = existingProducts.find((x) => x.custom_data?.key === p.key) || existingProducts.find((x) => x.name === p.name);
  if (found) { productId[p.key] = found.id; console.log(`product ${p.key.padEnd(8)} exists  ${found.id}`); continue; }
  const created = await call('POST', '/products', { name: p.name, description: p.description, tax_category: 'saas', custom_data: { key: p.key, plan: p.key } });
  productId[p.key] = created.data.id;
  console.log(`product ${p.key.padEnd(8)} created ${created.data.id}`);
}

const existingPrices = await list('/prices?per_page=200&status=active');
const priceId = {};
const stale = [];
for (const pr of PRICES) {
  const match = existingPrices.find((x) => x.custom_data?.key === pr.key && x.product_id === productId[pr.product]);
  if (match && Number(match.unit_price?.amount) === pr.amount) { priceId[pr.key] = match.id; console.log(`price   ${pr.key.padEnd(13)} exists  ${match.id} ($${(pr.amount / 100).toFixed(2)})`); continue; }
  if (match) stale.push({ id: match.id, key: pr.key, was: match.unit_price?.amount });
  const body = {
    product_id: productId[pr.product],
    description: pr.description,
    name: pr.name,
    unit_price: { amount: String(pr.amount), currency_code: 'USD' },
    quantity: { minimum: 1, maximum: 1 },
    tax_mode: 'account_setting',
    custom_data: pr.credits ? { key: pr.key, kind: 'credits', credits: String(pr.credits) } : { key: pr.key, kind: 'subscription', plan: pr.product, interval: pr.interval },
    ...(pr.interval ? { billing_cycle: { interval: pr.interval, frequency: 1 } } : {}),
  };
  const created = await call('POST', '/prices', body);
  priceId[pr.key] = created.data.id;
  console.log(`price   ${pr.key.padEnd(13)} created ${created.data.id} ($${(pr.amount / 100).toFixed(2)})`);
}

for (const s of stale) {
  try { await call('PATCH', `/prices/${s.id}`, { status: 'archived' }); console.log(`price   ${s.key.padEnd(13)} archived old ${s.id} (was $${(Number(s.was) / 100).toFixed(2)})`); }
  catch (e) { console.warn(`could not archive ${s.id}: ${e.message}`); }
}

console.log('\n--- env (Railway + local .env) ---');
for (const [key, name] of Object.entries(ENV_NAME)) console.log(`${name}=${priceId[key]}`);
console.log(`PADDLE_ENV=${MODE === 'live' || MODE === 'production' ? 'production' : 'sandbox'}`);
console.log('\nCredit packs carry custom_data.credits — the webhook reads that, so adding a pack later needs no code change.');
