'use strict';

const crypto = require('crypto');
const https = require('https');

/**
 * The two audits that need more than a look at one entry: finding passwords
 * that are nearly the same as each other, and asking Have I Been Pwned whether
 * a password has turned up in a breach.
 */

/* ------------------------------------------------------------ find similar */

/**
 * Similarity on a 0 to 1 scale using the Sorensen-Dice coefficient over
 * character bigrams. It catches the real pattern people use, "Summer2023" then
 * "Summer2024", without the cost of a full edit distance on every pair.
 */
function bigrams(text) {
  const set = new Map();
  for (let i = 0; i < text.length - 1; i++) {
    const pair = text.slice(i, i + 2);
    set.set(pair, (set.get(pair) || 0) + 1);
  }
  return set;
}

function diceCoefficient(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const left = bigrams(a);
  const right = bigrams(b);
  let shared = 0;
  let leftTotal = 0;
  let rightTotal = 0;
  for (const count of left.values()) leftTotal += count;
  for (const count of right.values()) rightTotal += count;
  for (const [pair, count] of left) {
    const other = right.get(pair);
    if (other) shared += Math.min(count, other);
  }
  return (2 * shared) / (leftTotal + rightTotal);
}

/**
 * Groups entries whose passwords are similar but not identical. Identical
 * passwords are already reported as reuse, so they are skipped here.
 */
function findSimilar(items, { threshold = 0.7, maxPairs = 400 } = {}) {
  const withPasswords = items.filter((item) => item.password && item.password.length > 3);
  const pairs = [];

  for (let i = 0; i < withPasswords.length; i++) {
    for (let j = i + 1; j < withPasswords.length; j++) {
      const a = withPasswords[i];
      const b = withPasswords[j];
      if (a.password === b.password) continue; // reuse, not similarity
      const score = diceCoefficient(a.password.toLowerCase(), b.password.toLowerCase());
      if (score >= threshold) {
        pairs.push({ a: a.summary, b: b.summary, similarity: Math.round(score * 100) });
        if (pairs.length >= maxPairs) break;
      }
    }
    if (pairs.length >= maxPairs) break;
  }

  pairs.sort((x, y) => y.similarity - x.similarity);
  return pairs;
}

/* --------------------------------------------------------- have i been pwned */

const HIBP_HOST = 'api.pwnedpasswords.com';
const rangeCache = new Map();

function fetchRange(prefix) {
  if (rangeCache.has(prefix)) return Promise.resolve(rangeCache.get(prefix));

  return new Promise((resolve, reject) => {
    const request = https.get(
      {
        host: HIBP_HOST,
        path: '/range/' + prefix,
        headers: {
          'User-Agent': 'Ironvault-Password-Manager',
          'Add-Padding': 'true' // pads the reply so its size leaks nothing
        },
        timeout: 20000
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('Have I Been Pwned returned HTTP ' + res.statusCode));
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          const found = new Map();
          for (const line of body.split(/\r?\n/)) {
            const [suffix, count] = line.split(':');
            if (suffix) found.set(suffix.trim().toUpperCase(), parseInt(count, 10) || 0);
          }
          rangeCache.set(prefix, found);
          resolve(found);
        });
      }
    );
    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy();
      reject(new Error('Have I Been Pwned timed out'));
    });
  });
}

/**
 * k-anonymity: only the first five characters of the SHA-1 hash leave this
 * machine, and the reply covers hundreds of hashes, so the service never learns
 * which password was asked about. Nothing else about the entry is sent.
 */
async function checkPwned(items, { onProgress } = {}) {
  const byHash = new Map();
  for (const item of items) {
    if (!item.password) continue;
    const hash = crypto.createHash('sha1').update(item.password, 'utf8').digest('hex').toUpperCase();
    if (!byHash.has(hash)) byHash.set(hash, []);
    byHash.get(hash).push(item.summary);
  }

  const prefixes = new Map();
  for (const hash of byHash.keys()) {
    const prefix = hash.slice(0, 5);
    if (!prefixes.has(prefix)) prefixes.set(prefix, []);
    prefixes.get(prefix).push(hash);
  }

  const breached = [];
  const errors = [];
  let done = 0;

  for (const [prefix, hashes] of prefixes) {
    try {
      const range = await fetchRange(prefix);
      for (const hash of hashes) {
        const count = range.get(hash.slice(5));
        if (count) {
          for (const summary of byHash.get(hash)) {
            breached.push({ ...summary, breachCount: count });
          }
        }
      }
    } catch (err) {
      errors.push(err.message);
    }
    done++;
    if (onProgress) onProgress({ done, total: prefixes.size });
  }

  breached.sort((a, b) => b.breachCount - a.breachCount);
  return {
    checked: byHash.size,
    requests: prefixes.size,
    breached,
    errors: [...new Set(errors)]
  };
}

module.exports = { findSimilar, checkPwned, diceCoefficient };
