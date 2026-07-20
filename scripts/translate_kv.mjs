// translate_kv.mjs - Translate ke (Korean-English) → kv (Korean-Vietnamese)
// Uses SDK directly, run with node (not bun), conservative rate limit.
//
// Usage:
//   node translate_kv.mjs [--limit=N] [--batch=N] [--resume]
//
// Run in background: nohup node translate_kv.mjs --resume > /tmp/kv.log 2>&1 &

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
const BATCH     = parseInt(args.batch || '10');
const RESUME    = args.resume === 'true' || args.resume === '1';
const INTERVAL  = parseInt(args.interval || '3500');  // ms between calls
const OUT_PATH  = '/home/z/my-project/scripts/kv_translations.jsonl';

fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });

// ---- Load SDK ----
const mod = await import('/home/z/.bun/install/global/node_modules/z-ai-web-dev-sdk/dist/index.js');
const ZAI = mod.default;
const zai = await ZAI.create();

// ---- Load source ----
console.log('[load] ke.json.gz ...');
const keRaw = zlib.gunzipSync(fs.readFileSync('/home/z/my-project/Multi-Dictionary/dict-data/ke.json.gz'));
const ke = JSON.parse(keRaw.toString('utf8'));
const words  = ke.w.split('\n');
const bodies = ke.b.split('\u0001');
console.log(`[load] ${words.length} entries loaded`);

const TOTAL = LIMIT || words.length;
console.log(`[plan] Will translate ${TOTAL} entries, batch=${BATCH}, interval=${INTERVAL}ms`);

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
  console.log(`[resume] Loaded ${doneMap.size} already-translated entries`);
}

// ---- Prompts ----
const SYSTEM_PROMPT = `You are a professional English-to-Vietnamese translator working on a Korean-English dictionary migration to Korean-Vietnamese.

CRITICAL RULES:
1. Translate ONLY English text to natural Vietnamese.
2. PRESERVE ALL DSL MARKUP tags exactly: [b], [/b], [i], [c color], [/c], [p], [/p], [tbl], [tr], [td], [/td], [/tr], [/tbl], [ref], [s], [fs spec], [hr], [ar], [/m], [/m0]-[/m9], and \\t<N>] line prefixes.
3. PRESERVE Korean text (Hangul like 가, 경연, 공정가) UNCHANGED.
4. PRESERVE Hanja (Chinese characters like 價, 硬軟) UNCHANGED.
5. PRESERVE IPA pronunciation (like bənǽlaiz) UNCHANGED.
6. PRESERVE punctuation 〈〉《》「」『』【】〚〛 [] {} () UNCHANGED.
7. PRESERVE special symbols ✧ ❑ ✪ ♦ ❖ • ━ UNCHANGED.
8. PRESERVE file refs like [s]acec.gif[/s] UNCHANGED.
9. PRESERVE backslash escapes \\\\[ \\\\] \\\\  UNCHANGED.
10. Output ONLY the translated body string (no JSON, no quotes, no commentary).

Examples:
Input:  \\t3][c indigo][b]경연[/b] [/td][/tr][/tbl]\\n\\t0][c brown](硬軟)[/c]   degree of hardness; hardness and 〈or〉 softness
Output: \\t3][c indigo][b]경연[/b] [/td][/tr][/tbl]\\n\\t0][c brown](硬軟)[/c]   độ cứng; độ cứng và 〈hoặc〉 độ mềm

Input:  \\t1][c darkviolet]❑[/c] a ferryman; a waterman
Output: \\t1][c darkviolet]❑[/c] người lái đò; người chèo thuyền`;

function buildUserPrompt(batch) {
  let parts = [];
  parts.push(`Translate each entry's body to Vietnamese following the rules. Output the same format with translated bodies. Preserve the <<<ENTRY>>> / <<<END>>> markers EXACTLY.\n`);
  for (const e of batch) {
    parts.push(`<<<ENTRY id="${e.i}">`);
    parts.push(e.body);
    parts.push(`<<<END>>>`);
  }
  return parts.join('\n');
}

function parseResponse(text) {
  const re = /<<<ENTRY id="(\d+)">\n([\s\S]*?)\n<<<END>>>/g;
  const map = new Map();
  let m;
  while ((m = re.exec(text)) !== null) {
    map.set(parseInt(m[1]), m[2]);
  }
  return map;
}

// ---- API call with rate limit + retry ----
let lastRequestAt = 0;

async function callApi(userPrompt) {
  // Wait for interval
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
  try {
    const resp = await callApi(userPrompt);
    const map = parseResponse(resp);
    const missing = batch.filter(e => !map.has(e.i));
    if (missing.length === 0) return { ok: true, map };
    if (missing.length < batch.length) {
      process.stdout.write(`[b${batchNum}] partial: ${missing.length}/${batch.length} missing, retrying\n`);
      try {
        const sub = await translateBatch(missing, batchNum);
        for (const [k, v] of sub.map) map.set(k, v);
      } catch {}
    }
    for (const e of batch) if (!map.has(e.i)) map.set(e.i, e.body);
    return { ok: true, map };
  } catch (err) {
    process.stdout.write(`[b${batchNum}] FATAL: ${err.message.slice(0,150)}, fallback to English\n`);
    const map = new Map();
    for (const e of batch) map.set(e.i, e.body);
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
      entries.push({ i: j, body: bodies[j] });
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
    if (done % 5 === 0 || done < 5) {
      const elapsed = (Date.now() - startAt) / 1000;
      const rate = (done / elapsed).toFixed(3);
      const eta = ((tasks.length - done) / Math.max(0.001, parseFloat(rate))).toFixed(0);
      process.stdout.write(`[progress] ${doneMap.size}/${TOTAL} (${(100*doneMap.size/TOTAL).toFixed(2)}%) | batch ${done}/${tasks.length} | last: ${dt}s | rate: ${rate} batch/s | ETA: ${eta}s (${(eta/3600).toFixed(2)}h)\n`);
    }
  }

  await new Promise(resolve => outStream.end(resolve));
  console.log(`\n[done] ${doneMap.size} entries translated. Saved to ${OUT_PATH}`);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
