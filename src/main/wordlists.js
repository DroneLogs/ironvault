'use strict';

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', 'wordlists');

let manifestCache = null;
const wordCache = new Map();

function manifest() {
  if (manifestCache) return manifestCache;
  try {
    manifestCache = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
  } catch (err) {
    console.error('Could not read the word list manifest: ' + err.message);
    manifestCache = [];
  }
  return manifestCache;
}

/** Lists offered in the passphrase generator, grouped the way the UI shows them. */
function catalogue() {
  return manifest()
    .filter((entry) => entry.category !== 'names')
    .map((entry) => ({
      key: entry.key,
      name: entry.name,
      category: entry.category,
      count: entry.count,
      bitsPerWord: entry.bitsPerWord,
      credit: entry.credit
    }));
}

function has(key) {
  return manifest().some((entry) => entry.key === key);
}

/** Loads a list once and keeps it, since a list is a megabyte at most. */
function words(key) {
  if (wordCache.has(key)) return wordCache.get(key);
  let list = [];
  try {
    list = fs
      .readFileSync(path.join(DIR, key + '.txt'), 'utf8')
      .split(/\r?\n/)
      .map((w) => w.trim())
      .filter(Boolean);
  } catch (err) {
    console.error('Could not read word list ' + key + ': ' + err.message);
  }
  wordCache.set(key, list);
  return list;
}

/**
 * Combines the selected lists into one pool of unique words. Entropy per word
 * is computed from the size of this pool, so mixing lists is accounted for
 * honestly rather than assumed to be 12.9 bits.
 */
function pool(keys) {
  const wanted = (Array.isArray(keys) ? keys : [keys]).filter((k) => has(k));
  if (!wanted.length) wanted.push('eff-large');
  if (wanted.length === 1) return words(wanted[0]);

  const seen = new Set();
  const combined = [];
  for (const key of wanted) {
    for (const word of words(key)) {
      const dedupeKey = word.toLowerCase();
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      combined.push(word);
    }
  }
  return combined;
}

function names(kind) {
  return words(kind === 'surname' ? 'names-surnames' : 'names-first');
}

module.exports = { catalogue, manifest, words, pool, has, names };
