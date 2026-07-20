// rebuild_dict_files.mjs - Generate kv.json.gz and vk.json.gz from translations + fallback.
//
// kv (Korean→Vietnamese):
//   headword = ke's Korean headword
//   body = translated body (from kv_translations.jsonl) or English fallback (from ke)
//
// vk (Vietnamese→Korean):
//   headword = translated Vietnamese headword (from vk_translations.jsonl) or English fallback (from ek)
//   body = ek's Korean body (unchanged)
//
// Usage: node rebuild_dict_files.mjs

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

const DICT_DATA = '/home/z/my-project/Multi-Dictionary/dict-data';
const KV_TRANS = '/home/z/my-project/scripts/kv_translations.jsonl';
const VK_TRANS = '/home/z/my-project/scripts/vk_translations.jsonl';

function loadTranslations(p) {
  const map = new Map();
  if (!fs.existsSync(p)) return map;
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const r = JSON.parse(line);
      map.set(r.i, r.v);
    } catch {}
  }
  return map;
}

function buildPrefixIndex(words, prefixLen) {
  const idx = {};
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w) continue;
    // Use first N chars as prefix
    let prefix = w.slice(0, prefixLen).toLowerCase();
    // For Vietnamese, also try the normalized (no-diacritic) prefix
    if (!(prefix in idx)) idx[prefix] = [i, i];
    idx[prefix][1] = i;
  }
  return idx;
}

// Better prefix index that matches the existing app's expectation
// The app uses p1 (1-char) and p2 (2-char) prefix indexes
// Each entry is [startIdx, endIdx] inclusive
function buildPrefixes(words) {
  const p1 = {};
  const p2 = {};
  for (let i = 0; i < words.length; i++) {
    const w = words[i] || '';
    // p1: first character
    const c1 = w.slice(0, 1);
    if (c1) {
      if (!(c1 in p1)) p1[c1] = [i, i];
      p1[c1][1] = i;
    }
    // p2: first two characters
    const c2 = w.slice(0, 2);
    if (c2.length === 2) {
      if (!(c2 in p2)) p2[c2] = [i, i];
      p2[c2][1] = i;
    } else if (c2.length === 1) {
      // single char word — use the char + space as p2? Or skip.
      // Actually for consistency, use the char itself
      if (!(c2 in p2)) p2[c2] = [i, i];
      p2[c2][1] = i;
    }
  }
  return { p1, p2 };
}

function normalizeVietnamese(s) {
  // Strip diacritics for Vietnamese search
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
}

// Build p1/p2 with both original and normalized Vietnamese prefixes
function buildPrefixesVietnamese(words) {
  const p1 = {};
  const p2 = {};
  for (let i = 0; i < words.length; i++) {
    const w = words[i] || '';
    const wn = normalizeVietnamese(w);
    // p1: first char (both original and normalized)
    for (const word of [w, wn]) {
      const c1 = word.slice(0, 1);
      if (c1) {
        if (!(c1 in p1)) p1[c1] = [i, i];
        p1[c1][1] = i;
      }
      const c2 = word.slice(0, 2);
      if (c2.length >= 1) {
        if (!(c2 in p2)) p2[c2] = [i, i];
        p2[c2][1] = i;
      }
    }
  }
  return { p1, p2 };
}

console.log('=== Building kv.json.gz (Korean → Vietnamese) ===');

// Load ke
console.log('[kv] loading ke.json.gz ...');
const keRaw = zlib.gunzipSync(fs.readFileSync(`${DICT_DATA}/ke.json.gz`));
const ke = JSON.parse(keRaw.toString('utf8'));
const keWords = ke.w.split('\n');
const keBodies = ke.b.split('\u0001');
console.log(`[kv] ke: ${keWords.length} entries`);

// Load translations
const kvTrans = loadTranslations(KV_TRANS);
console.log(`[kv] translations: ${kvTrans.size} entries`);

// Build kv
const kvWords = [];  // Korean headwords (same as ke)
const kvBodies = []; // Vietnamese translations or English fallback
let translated = 0, fallback = 0;
for (let i = 0; i < keWords.length; i++) {
  kvWords.push(keWords[i]);
  if (kvTrans.has(i)) {
    kvBodies.push(kvTrans.get(i));
    translated++;
  } else {
    // Fallback: use English body with a notice
    kvBodies.push(keBodies[i]);
    fallback++;
  }
}
console.log(`[kv] translated: ${translated}, fallback: ${fallback}`);

// Build prefixes (Korean headwords, same structure as ke)
const { p1: kvP1, p2: kvP2 } = buildPrefixes(kvWords);

const kv = {
  name: 'Korean-Vietnamese Dictionary (Hàn-Việt)',
  indexLang: 'Korean',
  contentsLang: 'Vietnamese',
  count: kvWords.length,
  w: kvWords.join('\n'),
  b: kvBodies.join('\u0001'),
  p1: kvP1,
  p2: kvP2
};
const kvJson = JSON.stringify(kv);
const kvGz = zlib.gzipSync(Buffer.from(kvJson, 'utf8'));
fs.writeFileSync(`${DICT_DATA}/kv.json.gz`, kvGz);
console.log(`[kv] saved kv.json.gz (${(kvGz.length/1024/1024).toFixed(2)} MB compressed, ${(kvJson.length/1024/1024).toFixed(2)} MB uncompressed)`);

console.log('\n=== Building vk.json.gz (Vietnamese → Korean) ===');

// Load ek
console.log('[vk] loading ek.json.gz ...');
const ekRaw = zlib.gunzipSync(fs.readFileSync(`${DICT_DATA}/ek.json.gz`));
const ek = JSON.parse(ekRaw.toString('utf8'));
const ekWords = ek.w.split('\n');
const ekBodies = ek.b.split('\u0001');
console.log(`[vk] ek: ${ekWords.length} entries`);

// Load translations
const vkTrans = loadTranslations(VK_TRANS);
console.log(`[vk] translations: ${vkTrans.size} entries`);

// Build vk
const vkWords = [];  // Vietnamese headwords (translated) or English fallback
const vkBodies = []; // Korean bodies (same as ek)
let vkTranslated = 0, vkFallback = 0;
for (let i = 0; i < ekWords.length; i++) {
  vkBodies.push(ekBodies[i]);
  if (vkTrans.has(i)) {
    vkWords.push(vkTrans.get(i));
    vkTranslated++;
  } else {
    vkWords.push(ekWords[i]);  // fallback to English
    vkFallback++;
  }
}
console.log(`[vk] translated: ${vkTranslated}, fallback: ${vkFallback}`);

// Build prefixes (Vietnamese headwords, with diacritic-stripped variants)
const { p1: vkP1, p2: vkP2 } = buildPrefixesVietnamese(vkWords);

const vk = {
  name: 'Vietnamese-Korean Dictionary (Việt-Hàn)',
  indexLang: 'Vietnamese',
  contentsLang: 'Korean',
  count: vkWords.length,
  w: vkWords.join('\n'),
  b: vkBodies.join('\u0001'),
  p1: vkP1,
  p2: vkP2
};
const vkJson = JSON.stringify(vk);
const vkGz = zlib.gzipSync(Buffer.from(vkJson, 'utf8'));
fs.writeFileSync(`${DICT_DATA}/vk.json.gz`, vkGz);
console.log(`[vk] saved vk.json.gz (${(vkGz.length/1024/1024).toFixed(2)} MB compressed, ${(vkJson.length/1024/1024).toFixed(2)} MB uncompressed)`);

console.log('\n=== Done ===');
console.log('Files created:');
console.log(`  ${DICT_DATA}/kv.json.gz`);
console.log(`  ${DICT_DATA}/vk.json.gz`);
