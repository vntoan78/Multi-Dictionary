// translate_vk.mjs - Translate ek (English-Korean) → vk (Vietnamese-Korean)
// Strategy: translate ONLY the English headword to Vietnamese. Keep Korean body unchanged.
// Headwords are short, so we can batch 50 per call.
//
// Usage:
//   node translate_vk.mjs [--limit=N] [--batch=N] [--resume] [--interval=3000]

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

// ---- Args ----
const args = process.argv.slice(2).reduce((acc, a) => {
  const m = a.match(/^--(\w+)=(.+)$/);
  if (m) { acc[m[1]] = m[2]; return acc; }
  const m2 = a.match(/^--(\w+)$/);
  if (m2) { acc[m2[1]] = 'true'; return acc; }
  return acc;
}, {});
const LIMIT     = args.limit ? parseInt(args.limit) : 0;
const BATCH     = parseInt(args.batch || '50');
const RESUME    = args.resume === 'true' || args.resume === '1';
const INTERVAL  = parseInt(args.interval || '3000');
const OUT_PATH  = '/home/z/my-project/scripts/vk_translations.jsonl';

fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });

// ---- Load SDK ----
const mod = await import('/home/z/.bun/install/global/node_modules/z-ai-web-dev-sdk/dist/index.js');
const ZAI = mod.default;
const zai = await ZAI.create();

// ---- Load source ----
console.log('[load] ek.json.gz ...');
const ekRaw = zlib.gunzipSync(fs.readFileSync('/home/z/my-project/Multi-Dictionary/dict-data/ek.json.gz'));
const ek = JSON.parse(ekRaw.toString('utf8'));
const words  = ek.w.split('\n');
const bodies = ek.b.split('\u0001');
console.log(`[load] ${words.length} entries loaded`);

const TOTAL = LIMIT || words.length;
console.log(`[plan] Will translate ${TOTAL} headwords, batch=${BATCH}, interval=${INTERVAL}ms`);

// ---- Resume ----
const doneMap = new Map();
if (RESUME && fs.existsSync(OUT_PATH)) {
  const lines = fs.readFileSync(OUT_PATH, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const r = JSON.parse(line);
      doneMap.set(r.i, r.v);
    } catch {}
  }
  console.log(`[resume] Loaded ${doneMap.size} already-translated headwords`);
}

// ---- Prompts ----
const SYSTEM_PROMPT = `You are a professional English-to-Vietnamese translator for a dictionary migration from English-Korean to Vietnamese-Korean.

Your task: translate each English headword to its most natural Vietnamese equivalent.

Rules:
1. Output ONLY the Vietnamese translation (no English, no commentary, no pronunciation).
2. If the headword has multiple words (e.g. "crotonic acid"), translate the whole phrase.
3. If the headword is a proper noun, brand, abbreviation, or symbol (like "$", "?", "@", "Jn"), keep it as-is.
4. If the headword has pronunciation markers (like "ba·nal·ize" with middle dots), strip the dots and translate the word.
5. For technical/scientific terms, use the standard Vietnamese term if it exists; otherwise keep the English term.
6. Keep hyphens, apostrophes, and other punctuation as appropriate.

Examples:
"price" → "giá"
"a ferryman" → "người lái đò"
"crotonic acid" → "axit crotonic"
"apple-pie" → "bánh táo"
"$" → "$"
"Jn" → "Jn"
"ba·nal·ize" → "tầm thường hóa"`;

function buildUserPrompt(batch) {
  // Use simple format: id|english
  let lines = [`Translate each English headword to Vietnamese. Output one line per entry as "id|vietnamese". Preserve the id exactly.\n`];
  for (const e of batch) {
    lines.push(`${e.i}|${e.en}`);
  }
  return lines.join('\n');
}

function parseResponse(text, expectedIds) {
  const map = new Map();
  for (const line of text.split('\n')) {
    const m = line.match(/^(\d+)\|(.+)$/);
    if (m) {
      const id = parseInt(m[1]);
      const vi = m[2].trim();
      if (expectedIds.has(id) && vi.length > 0) {
        map.set(id, vi);
      }
    }
  }
  return map;
}

// ---- API call with rate limit + retry ----
let lastRequestAt = 0;

async function callApi(userPrompt) {
  const now = Date.now();
  const wait0 = Math.max(0, lastRequestAt + INTERVAL - now);
  if (wait0 > 0) await new Promise(r => setTimeout(r, wait0));
  lastRequestAt = Date.now();

  let attempts = 0;
  const MAX = 8;
  while (true) {
    try {
      const completion = await zai.chat.completions.create({
        messages: [
          { role: 'assistant', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt }
        ],
        thinking: { type: 'disabled' }
      });
      return completion.choices?.[0]?.message?.content || '';
    } catch (err) {
      attempts++;
      const msg = (err && err.message) ? err.message : String(err);
      const is429 = msg.includes('429') || msg.includes('Too many');
      if (attempts >= MAX) throw new Error(`API failed after ${MAX}: ${msg.slice(0,200)}`);
      const wait = is429 ? (30000 * attempts) : (5000 * attempts);
      process.stdout.write(`[retry ${attempts}] wait ${wait}ms: ${msg.slice(0,80)}\n`);
      await new Promise(r => setTimeout(r, wait));
      lastRequestAt = Date.now();
    }
  }
}

// ---- Translate one batch ----
async function translateBatch(batch, batchNum) {
  const userPrompt = buildUserPrompt(batch);
  const expectedIds = new Set(batch.map(e => e.i));
  try {
    const resp = await callApi(userPrompt);
    const map = parseResponse(resp, expectedIds);
    const missing = batch.filter(e => !map.has(e.i));
    if (missing.length === 0) return { ok: true, map };
    if (missing.length < batch.length) {
      process.stdout.write(`[b${batchNum}] partial: ${missing.length}/${batch.length} missing, retrying\n`);
      try {
        const sub = await translateBatch(missing, batchNum);
        for (const [k, v] of sub.map) map.set(k, v);
      } catch {}
    }
    // fallback: use English headword as Vietnamese (better than nothing)
    for (const e of batch) if (!map.has(e.i)) map.set(e.i, e.en);
    return { ok: true, map };
  } catch (err) {
    process.stdout.write(`[b${batchNum}] FATAL: ${err.message.slice(0,150)}, fallback to English\n`);
    const map = new Map();
    for (const e of batch) map.set(e.i, e.en);
    return { ok: false, map };
  }
}

// ---- Main (sequential) ----
process.on('unhandledRejection', (err) => console.error('[unhandled]', err));
process.on('uncaughtException', (err) => console.error('[uncaught]', err));

async function main() {
  const tasks = [];
  let batchNum = 0;
  for (let i = 0; i < TOTAL; i += BATCH) {
    const entries = [];
    for (let j = i; j < Math.min(i + BATCH, TOTAL); j++) {
      if (doneMap.has(j)) continue;
      entries.push({ i: j, en: words[j] });
    }
    if (entries.length === 0) continue;
    tasks.push({ batchNum: ++batchNum, entries });
  }
  console.log(`[plan] ${tasks.length} batches queued`);
  if (tasks.length === 0) { console.log('[done] nothing to do'); return; }

  const outStream = fs.createWriteStream(OUT_PATH, { flags: 'a' });
  function sink(i, v) {
    doneMap.set(i, v);
    outStream.write(JSON.stringify({ i, v }) + '\n');
  }

  const startAt = Date.now();
  let done = 0;
  for (const task of tasks) {
    const t0 = Date.now();
    const result = await translateBatch(task.entries, task.batchNum);
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    for (const e of task.entries) {
      const v = result.map.get(e.i);
      if (v != null) sink(e.i, v);
    }
    done++;
    if (done % 3 === 0 || done < 5) {
      const elapsed = (Date.now() - startAt) / 1000;
      const rate = (done / elapsed).toFixed(3);
      const eta = ((tasks.length - done) / Math.max(0.001, parseFloat(rate))).toFixed(0);
      process.stdout.write(`[progress] ${doneMap.size}/${TOTAL} (${(100*doneMap.size/TOTAL).toFixed(2)}%) | batch ${done}/${tasks.length} | last: ${dt}s | rate: ${rate} batch/s | ETA: ${eta}s (${(eta/3600).toFixed(2)}h)\n`);
    }
  }

  await new Promise(resolve => outStream.end(resolve));
  console.log(`\n[done] ${doneMap.size} headwords translated. Saved to ${OUT_PATH}`);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
