// index.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import path from 'path';
import { fileURLToPath } from 'url';
import { BigQuery } from '@google-cloud/bigquery';
import https from 'https';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const PORT        = process.env.PORT || 8080;
const BQ_PROJECT  = process.env.BQ_PROJECT  || 'capstone-project-470009';
const BQ_DATASET  = process.env.BQ_DATASET  || 'real_estate_aggregated_data';
const BQ_TABLE    = process.env.BQ_TABLE    || 'current_listings';
const BQ_LOCATION = process.env.BQ_LOCATION || 'us-central1';

const N8N_CHAT_URL =
  process.env.N8N_CHAT_URL ||
  'https://if33d4l0t.app.n8n.cloud/webhook/df2e591c-d024-45db-8460-d8b0f10964d7';

const MODEL_BASE =
  process.env.MODEL_BASE ||
  'https://vertex-ml-app-338850593340.europe-west1.run.app';

const RECOMMENDER_URL =
  process.env.RECOMMENDER_URL ||
  'https://estate-mate-recommendation-model-338850593340.europe-west1.run.app/recommend';

  const bigQueryOptions = { projectId: BQ_PROJECT, location: BQ_LOCATION };

  // In production (Render, etc.) we’ll pass the service account JSON via env var
  if (process.env.GCP_SERVICE_ACCOUNT_JSON) {
    try {
      bigQueryOptions.credentials = JSON.parse(process.env.GCP_SERVICE_ACCOUNT_JSON);
    } catch (err) {
      console.error('Failed to parse GCP_SERVICE_ACCOUNT_JSON', err);
    }
  }

  const bq = new BigQuery(bigQueryOptions);

const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan('tiny'));

/* ---------------- In-memory prefs store ---------------- */
const PREFS_STORE = new Map(); // sessionId -> prefs object

const sanitize = (o={})=>{
  const out={};
  for (const [k,v] of Object.entries(o)) {
    const s = (v ?? '').toString().trim();
    if (s) out[k]=s;
  }
  return out;
};

const summarizePrefs = (p={})=>{
  if (!Object.keys(p).length) return "You currently have no saved preferences.";
  const bits = [];
  if (p.community)  bits.push(`community: ${p.community}`);
  if (p.ptype)      bits.push(`property type: ${p.ptype}`);
  if (p.bedrooms)   bits.push(`bedrooms: ${p.bedrooms}`);
  if (p.musthave)   bits.push(`must-have: ${p.musthave}`);
  if (p.lifestyle)  bits.push(`lifestyle: ${p.lifestyle}`);
  if (p.personality)bits.push(`personality: ${p.personality}`);
  if (p.style)      bits.push(`style: ${p.style}`);
  if (p.commute)    bits.push(`commute: ${p.commute}`);
  if (p.budget)     bits.push(`budget mindset: ${p.budget}`);
  return "Your saved preferences are — " + bits.join(", ") + ".";
};

/* ---------------- BigQuery (listings) ---------------- */
const fqTable = `\`${BQ_PROJECT}.${BQ_DATASET}.${BQ_TABLE}\``;
const FIELDS = `
  listing_id, title, property_type, price,
  bedrooms, bathrooms, size_sqft, view, parking_spaces,
  city, community, building,
  latitude, longitude
`;

app.get('/api/health', async (_req, res) => {
  try { await bq.query({ query: 'SELECT 1 AS ok', location: BQ_LOCATION });
    res.json({ ok:true, bigquery:true });
  } catch (err) { res.status(500).json({ ok:false, error: err?.message || String(err) }); }
});

app.get('/api/listings', async (req, res) => {
  const city     = req.query.city || null;
  const minPrice = req.query.minPrice ? Number(req.query.minPrice) : null;
  const maxPrice = req.query.maxPrice ? Number(req.query.maxPrice) : null;
  const limit    = req.query.limit ? Number(req.query.limit) : 30;
  const id       = req.query.id || null;

  const sql = `
    SELECT ${FIELDS}
    FROM ${fqTable}
    WHERE (@id IS NULL OR CAST(listing_id AS STRING) = @id)
      AND (@city IS NULL OR LOWER(city) = LOWER(@city))
      AND (@minPrice IS NULL OR price >= @minPrice)
      AND (@maxPrice IS NULL OR price <= @maxPrice)
    ORDER BY price DESC
    LIMIT @limit
  `;
  try {
    const [rows] = await bq.query({
      query: sql,
      params: { id, city, minPrice, maxPrice, limit },
      types: { id:'STRING', city:'STRING', minPrice:'INT64', maxPrice:'INT64', limit:'INT64' },
      location: BQ_LOCATION,
    });

    const listings = rows.map(r => ({
      ...r,
      price:          r.price == null ? null : Number(r.price),
      bedrooms:       r.bedrooms == null ? null : Number(r.bedrooms),
      bathrooms:      r.bathrooms == null ? null : Number(r.bathrooms),
      size_sqft:      r.size_sqft == null ? null : Number(r.size_sqft),
      parking_spaces: r.parking_spaces == null ? null : Number(r.parking_spaces),
      latitude:       r.latitude == null ? null : Number(r.latitude),
      longitude:      r.longitude == null ? null : Number(r.longitude),
      images: [],
    }));

    res.json({ ok:true, count:listings.length, listings });
  } catch (err) {
    console.error('GET /api/listings error:', err);
    res.status(500).json({ ok:false, error: err?.message || String(err) });
  }
});

/* ---------------- Chat relay ---------------- */
function smartParse(strOrObj) {
  if (typeof strOrObj === 'object' && strOrObj !== null) return strOrObj;
  const txt = String(strOrObj ?? '').trim();
  if (!txt) return null;
  try {
    const once = JSON.parse(txt);
    if (typeof once === 'string') {
      try { return JSON.parse(once); } catch { return { output: once }; }
    }
    return once;
  } catch {
    return { output: txt };
  }
}
function extractAnswer(payload) {
  const j = smartParse(payload);
  const candidate =
    j?.answer ?? j?.output?.answer ?? j?.output?.state ??
    j?.output ?? j?.content ?? j?.message ?? j?.result ?? '';
  return (typeof candidate === 'string' && candidate.trim())
    ? candidate.trim()
    : JSON.stringify(j ?? payload);
}
function callN8n(question, sessionId, prefs = {}) {
  const clean = sanitize(prefs);
  if (clean.community) clean.locations    = clean.community;
  if (clean.ptype)     clean.propertyType = clean.ptype;
  if (clean.bedrooms)  clean.bedroom      = clean.bedrooms;

  const url = new URL(N8N_CHAT_URL);
  url.searchParams.set('question',  question);
  url.searchParams.set('sessionId', sessionId);
  url.searchParams.set('prefs_json', JSON.stringify(clean));
  Object.entries(clean).forEach(([k,v])=>url.searchParams.set(k,v));

  return new Promise((resolve, reject)=>{
    https.get(url.toString(), (resp)=>{
      let data=''; resp.on('data', c=>data+=c);
      resp.on('end', ()=>{
        const answer = extractAnswer(data);
        if (resp.statusCode && resp.statusCode >= 400) {
          return resolve({ ok:false, error:`n8n HTTP ${resp.statusCode}`, answer, raw:data });
        }
        resolve({ ok:true, answer, raw:data });
      });
    }).on('error', reject);
  });
}
function gatherPrefsFromQuery(q) {
  const prefs = {};
  for (const [k, v] of Object.entries(q)) {
    const m = /^prefs\[(.+)\]$/.exec(k);
    if (m) prefs[m[1]] = v;
  }
  if (!Object.keys(prefs).length && q.prefs_json) {
    try { Object.assign(prefs, JSON.parse(q.prefs_json)); } catch {}
  }
  return sanitize(prefs);
}
app.get('/api/chat', async (req, res) => {
  try {
    const src       = req.query;
    const question  = (src?.question || '').trim();
    const sessionId = src?.sessionId || src?.sessionID || src?.sessioniD || 'default-session';

    const incoming = gatherPrefsFromQuery(req.query);
    const stored   = PREFS_STORE.get(sessionId) || {};
    const merged   = { ...stored, ...incoming };

    if (Object.keys(incoming).length || question === '__prefs__') {
      PREFS_STORE.set(sessionId, merged);
    }

    const qLower = question.toLowerCase();
    if (qLower === '__prefs__') {
      return res.json({ ok:true, answer: '✅ Preferences saved.', raw: JSON.stringify(merged) });
    }
    if (qLower.includes('what are my preferences') || qLower === '__get_prefs__') {
      return res.json({ ok:true, answer: summarizePrefs(merged), raw: JSON.stringify(merged) });
    }

    const result = await callN8n(question, sessionId, merged);
    const havePrefs = Object.keys(merged).length > 0;
    const looksEmpty = /no preferences/i.test(result.answer || '');
    if (havePrefs && (looksEmpty || !result.ok)) {
      return res.json({ ok:true, answer: summarizePrefs(merged), raw: result.raw });
    }

    res.json({ ok:true, answer: result.answer, raw: result.raw });
  } catch (err) {
    console.error('call n8n error:', err);
    res.status(500).json({ ok:false, error:'Chat failed' });
  }
});

/* ---------------- Prediction proxy (robust + scaling) ---------------- */

// POST helper (HTTPS)
function postJson(urlString, bodyObj){
  const u = new URL(urlString);
  const opts = {
    method: 'POST',
    hostname: u.hostname,
    path: u.pathname + (u.search || ''),
    protocol: u.protocol,
    headers: { 'Content-Type': 'application/json' }
  };
  return new Promise((resolve, reject)=>{
    const req = https.request(opts, (resp)=>{
      let data=''; resp.on('data', c=>data+=c);
      resp.on('end', ()=>{
        try {
          const json = JSON.parse(data || '{}');
          resolve({ status: resp.statusCode||200, json });
        } catch {
          resolve({ status: resp.statusCode||200, json: { raw:data }});
        }
      });
    });
    req.on('error', reject);
    req.write(JSON.stringify(bodyObj||{}));
    req.end();
  });
}

// Recursively search for a numeric-looking prediction
function deepFindNumber(obj){
  const visited = new Set();
  const stack = [obj];
  let best = null;

  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object') continue;
    if (visited.has(cur)) continue;
    visited.add(cur);

    for (const [k, v] of Object.entries(cur)) {
      if (v == null) continue;
      const keyHit = /pred(i(ct|cted)?)?_?price|price|pred(i(ct|ction))|value|amount/i.test(k);

      if (typeof v === 'number' && isFinite(v)) {
        if (keyHit) return v;
        if (best == null) best = v;
      } else if (typeof v === 'string') {
        const m = v.replace(/[, ]/g,'').match(/^(-?\d+(\.\d+)?)$/);
        if (m) {
          const num = Number(m[1]);
          if (isFinite(num)) {
            if (keyHit) return num;
            if (best == null) best = num;
          }
        }
      } else if (typeof v === 'object') {
        stack.push(v);
      }
    }
  }
  return best;
}
function choosePlausibleTotal(rawNumber, features = {}) {
  const area = Number(features.procedure_area) || 0;
  const PL_MIN = 50_000;
  const PL_MAX = 2_000_000_000;
  const cands = [];
  const push = (val, rule) => { const n = Number(val); if (Number.isFinite(n)) cands.push({ n, rule }); };

  push(rawNumber, 'raw');
  if (area > 0) {
    push(rawNumber * area, 'per_sqm');
    push(Math.exp(rawNumber) * area, 'exp_per_sqm');
    push(Math.pow(10, rawNumber) * area, 'pow10_per_sqm');
  }
  push(Math.exp(rawNumber), 'exp');
  push(Math.pow(10, rawNumber), 'pow10');
  push(rawNumber * 1_000, 'x1000');

  const plausible = cands.filter(c => c.n >= PL_MIN && c.n <= PL_MAX);
  if (plausible.length) {
    plausible.sort((a, b) => {
      const aBonus = a.rule.includes('per_sqm') ? 1 : 0;
      const bBonus = b.rule.includes('per_sqm') ? 1 : 0;
      if (aBonus !== bBonus) return bBonus - aBonus;
      return b.n - a.n;
    });
    return plausible[0];
  }
  cands.sort((a,b)=>b.n-a.n);
  return cands[0] || { n: rawNumber, rule: 'raw' };
}
async function tryAllShapes(body){
  const shapes = [ body, { data: body }, { data: [body] } ];
  const paths  = ['/predict', '/'];

  for (const p of paths) {
    for (const shape of shapes) {
      const { status, json } = await postJson(`${MODEL_BASE}${p}`, shape);
      const rawNum = deepFindNumber(json);
      if (isFinite(rawNum ?? NaN)) {
        const chosen = choosePlausibleTotal(rawNum, body);
        return {
          status, raw: json,
          predicted_price_raw: Number(rawNum),
          predicted_price: Number(chosen.n),
          used_rule: chosen.rule,
        };
      }
    }
  }
  const last = await postJson(`${MODEL_BASE}/predict`, body);
  const rawNum = deepFindNumber(last.json);
  const chosen = isFinite(rawNum ?? NaN)
    ? choosePlausibleTotal(rawNum, body)
    : { n: null, rule: null };

  return {
    status: last.status,
    raw: last.json,
    predicted_price_raw: isFinite(rawNum ?? NaN) ? Number(rawNum) : null,
    predicted_price: isFinite(chosen.n ?? NaN) ? Number(chosen.n) : null,
    used_rule: chosen.rule
  };
}

app.post('/api/predict', async (req, res)=>{
  try{
    const body = req.body || {};
    const result = await tryAllShapes(body);
    res.status(result.status || 200).json({
      ok: true,
      predicted_price: result.predicted_price,
      predicted_price_raw: result.predicted_price_raw,
      used_rule: result.used_rule,
      raw: result.raw
    });
  }catch(err){
    console.error('Predict proxy error:', err);
    res.status(500).json({ ok:false, error: err?.message || String(err) });
  }
});

/* ---------------- Recommendation proxy (CORS-safe) ---------------- */
app.post('/api/recommend', async (req, res)=>{
  try{
    const payload = req.body || {};
    const { status, json } = await postJson(RECOMMENDER_URL, payload);
    res.status(status || 200).json(json);
  }catch(err){
    console.error('Recommend proxy error:', err);
    res.status(500).json({ ok:false, error: err?.message || String(err) });
  }
});

/* ---------------- Static ---------------- */
const WEB_ROOT = path.resolve(__dirname, '..');
app.use(express.static(WEB_ROOT));
app.get('/',        (_req, res) => res.sendFile(path.join(WEB_ROOT, 'index.html')));
app.get('/browse',  (_req, res) => res.sendFile(path.join(WEB_ROOT, 'browse.html')));
app.get('/listing', (_req, res) => res.sendFile(path.join(WEB_ROOT, 'listing.html')));
app.get('/about',   (_req, res) => res.sendFile(path.join(WEB_ROOT, 'about.html')));
app.get('/contact', (_req, res) => res.sendFile(path.join(WEB_ROOT, 'contact.html')));
app.get('/auth',    (_req, res) => res.sendFile(path.join(WEB_ROOT, 'auth.html')));
app.use((_req, res) => res.status(404).send('404 The requested path could not be found'));

app.listen(PORT, ()=>console.log(`EstateMate API running at http://localhost:${PORT}`));
