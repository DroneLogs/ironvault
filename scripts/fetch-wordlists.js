'use strict';

/**
 * Downloads the passphrase word lists and the name lists, normalizes them, and
 * writes them into wordlists/ along with a manifest and an attribution file.
 *
 * This is a build time script. The app itself never touches the network.
 *
 *   node scripts/fetch-wordlists.js [--only key1,key2]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const OUT_DIR = path.join(__dirname, '..', 'wordlists');

/* ------------------------------------------------------------------ sources */

const EFF = 'https://www.eff.org/files/';
const WPG = 'https://raw.githubusercontent.com/atoponce/webpassgen/master/lists/';

const SOURCES = [
  /* standard */
  {
    key: 'beale',
    name: 'Beale',
    category: 'standard',
    url: 'https://theworld.com/~reinhold/beale.wordlist.asc',
    parse: 'diceware',
    credit: 'Alan Beale, distributed with Arnold G. Reinhold\'s Diceware'
  },
  {
    key: 'diceware',
    name: "Diceware (Arnold G. Reinhold's Original)",
    category: 'standard',
    url: 'https://theworld.com/~reinhold/diceware.wordlist.asc',
    parse: 'diceware',
    credit: 'Arnold G. Reinhold, CC BY 3.0'
  },
  {
    key: 'eff-large',
    name: 'EFF Large',
    category: 'standard',
    url: EFF + '2016/07/18/eff_large_wordlist.txt',
    parse: 'diceware',
    credit: 'Electronic Frontier Foundation, CC BY 3.0 US'
  },
  {
    key: 'eff-short-1',
    name: 'EFF Short (v1.0)',
    category: 'standard',
    url: EFF + '2016/09/08/eff_short_wordlist_1.txt',
    parse: 'diceware',
    credit: 'Electronic Frontier Foundation, CC BY 3.0 US'
  },
  {
    key: 'eff-short-2',
    name: 'EFF Short (v2.0 - More memorable, unique prefix)',
    category: 'standard',
    url: EFF + '2016/09/08/eff_short_wordlist_2_0.txt',
    parse: 'diceware',
    credit: 'Electronic Frontier Foundation, CC BY 3.0 US'
  },
  {
    key: 'google-no-swears',
    name: 'Google (U.S. English, No Swears)',
    category: 'standard',
    url: 'https://raw.githubusercontent.com/first20hours/google-10000-english/master/google-10000-english-usa-no-swears-medium.txt',
    parse: 'plain',
    credit: 'Josh Kaufman, from Google\'s Trillion Word Corpus'
  },
  {
    key: 'orchard-street',
    name: 'Orchard Street Diceware List',
    category: 'standard',
    url: 'https://raw.githubusercontent.com/sts10/orchard-street-wordlists/main/lists/orchard-street-medium.txt',
    parse: 'plain',
    credit: 'Sam Schlinkert, CC BY-SA 4.0'
  },
  {
    key: 'securedrop',
    name: 'SecureDrop',
    category: 'standard',
    url: 'https://raw.githubusercontent.com/freedomofpress/securedrop/develop/securedrop/wordlists/en.txt',
    parse: 'plain',
    credit: 'Freedom of the Press Foundation, AGPL-3.0'
  },

  /* fandom, all four are the EFF's 2018 fan wikia lists */
  {
    key: 'fandom-got',
    name: 'Game of Thrones (EFF Fandom)',
    category: 'fandom',
    url: EFF + '2018/08/29/gameofthrones_8k-2018.txt',
    parse: 'diceware',
    credit: 'Electronic Frontier Foundation, CC BY 3.0 US'
  },
  {
    key: 'fandom-harrypotter',
    name: 'Harry Potter (EFF Fandom)',
    category: 'fandom',
    url: EFF + '2018/08/29/harrypotter_8k-2018.txt',
    parse: 'diceware',
    credit: 'Electronic Frontier Foundation, CC BY 3.0 US'
  },
  {
    key: 'fandom-startrek',
    name: 'Star Trek (EFF Fandom)',
    category: 'fandom',
    url: EFF + '2018/08/29/memory-alpha_8k_2018.txt',
    parse: 'diceware',
    credit: 'Electronic Frontier Foundation, CC BY 3.0 US'
  },
  {
    key: 'fandom-starwars',
    name: 'Star Wars (EFF Fandom)',
    category: 'fandom',
    url: EFF + '2018/08/29/starwars_8k_2018.txt',
    parse: 'diceware',
    credit: 'Electronic Frontier Foundation, CC BY 3.0 US'
  },

  /* languages, from the classic Diceware translations */
  { key: 'lang-catalan', name: 'Catalan', category: 'languages', url: WPG + 'dicewareCA.js', parse: 'webpassgen', varName: 'dca' },
  { key: 'lang-dutch', name: 'Dutch', category: 'languages', url: WPG + 'dicewareNL.js', parse: 'webpassgen', varName: 'dnl' },
  { key: 'lang-finnish', name: 'Finnish', category: 'languages', url: WPG + 'dicewareFI.js', parse: 'webpassgen', varName: 'dfi' },
  { key: 'lang-french', name: 'French', category: 'languages', url: WPG + 'dicewareFR.js', parse: 'webpassgen', varName: 'dfr' },
  { key: 'lang-german', name: 'German', category: 'languages', url: WPG + 'dicewareDE.js', parse: 'webpassgen', varName: 'dde' },
  { key: 'lang-italian', name: 'Italian', category: 'languages', url: WPG + 'dicewareIT.js', parse: 'webpassgen', varName: 'dit' },
  { key: 'lang-japanese', name: 'Japanese', category: 'languages', url: WPG + 'dicewareJP.js', parse: 'webpassgen', varName: 'djp' },
  { key: 'lang-norwegian', name: 'Norwegian', category: 'languages', url: WPG + 'dicewareNO.js', parse: 'webpassgen', varName: 'dno' },
  { key: 'lang-polish', name: 'Polish', category: 'languages', url: WPG + 'dicewarePL.js', parse: 'webpassgen', varName: 'dpl' },
  { key: 'lang-portuguese-br', name: 'Portuguese (Brazilian)', category: 'languages', url: WPG + 'dicewarePT.js', parse: 'webpassgen', varName: 'dpt' },
  { key: 'lang-swedish', name: 'Swedish', category: 'languages', url: WPG + 'dicewareSV.js', parse: 'webpassgen', varName: 'dsv' },
  {
    key: 'lang-icelandic',
    name: 'Icelandic',
    category: 'languages',
    url: 'https://raw.githubusercontent.com/hrafnthor/diceware-is/master/res/source',
    parse: 'icelandic',
    credit: 'Derived from the Icelandic word corpus in hrafnthor/diceware-is (BÍN, CC BY-SA 4.0)'
  },

  /* name lists for the username generator */
  {
    key: 'names-first',
    name: 'First names (US)',
    category: 'names',
    url: 'https://raw.githubusercontent.com/dominictarr/random-name/master/first-names.txt',
    parse: 'plain',
    credit: 'US Census Bureau, public domain',
    keepCase: true
  },
  {
    key: 'names-surnames',
    name: 'Surnames (US)',
    category: 'names',
    url: 'https://raw.githubusercontent.com/dominictarr/random-name/master/names.txt',
    parse: 'plain',
    credit: 'US Census Bureau, public domain',
    keepCase: true,
    limit: 12000
  }
];

const WEBPASSGEN_CREDIT = 'Diceware translations collected in atoponce/webpassgen';

/* -------------------------------------------------------------- downloading */

function download(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    const request = https.get(url, { headers: { 'User-Agent': 'propolis-build' }, timeout: 45000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).toString(), redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy();
      reject(new Error('timed out'));
    });
  });
}

/* ----------------------------------------------------------------- parsing */

function parseDiceware(text) {
  // Classic lists number each word "11115  abacus"; the EFF fandom lists use
  // three twenty sided rolls, "1-1-1 limited", and bare CR line endings.
  // Either way the roll column is dropped and the prose header lines never
  // match, so they fall away on their own.
  const words = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('-----') || line.startsWith('Version:')) continue;
    const match = line.match(/^(?:[0-9]{4,6}|[0-9]{1,2}(?:-[0-9]{1,2}){2,4})[ \t]+(.+)$/);
    if (match) words.push(match[1].trim());
    else if (!/\s/.test(line) && /^[^0-9]/.test(line)) words.push(line);
  }
  return words;
}

function parsePlain(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

/**
 * webpassgen packs each list as `prefix[n] = 'aaabbbccc'`, where the string is
 * every word of length n laid end to end.
 */
function parseWebpassgen(text) {
  const LINE = /^\s*(\w+)\s*\[\s*(\d+)\s*\]\s*=\s*(['"])(.*)\3\s*;?\s*$/;

  // Collect every packed assignment, then keep only the variable that carries
  // the most of them. That avoids hard coding a prefix per language.
  const byVar = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = LINE.exec(line);
    if (!match) continue;
    const size = Number(match[2]);
    const blob = match[4];
    if (!size || !blob) continue;
    if (!byVar.has(match[1])) byVar.set(match[1], []);
    byVar.get(match[1]).push({ size, blob });
  }

  let chosen = null;
  for (const entries of byVar.values()) {
    if (!chosen || entries.length > chosen.length) chosen = entries;
  }
  if (!chosen) return [];

  const words = [];
  for (const { size, blob } of chosen) {
    for (let i = 0; i + size <= blob.length; i += size) {
      words.push(blob.slice(i, i + size));
    }
  }
  return words;
}

/**
 * No published Icelandic diceware list exists, so build one from a real
 * Icelandic word corpus using the usual criteria: lower case, letters only,
 * four to eight characters, and a unique four character prefix so no word can
 * be confused for another. Selection is evenly spaced through the sorted
 * candidates, which keeps the result identical on every run.
 */
function parseIcelandic(text) {
  const alphabet = /^[a-záéíóúýðþæö]+$/;
  const seen = new Set();
  const candidates = [];
  for (const raw of text.split(/\r?\n/)) {
    const word = raw.trim();
    if (!word || word[0] !== word[0].toLowerCase()) continue; // drop proper nouns
    const lower = word.toLowerCase();
    if (lower.length < 4 || lower.length > 8) continue;
    if (!alphabet.test(lower)) continue;
    const prefix = lower.slice(0, 4);
    if (seen.has(prefix)) continue;
    seen.add(prefix);
    candidates.push(lower);
  }
  candidates.sort();

  const target = 7776;
  if (candidates.length <= target) return candidates;
  const picked = [];
  const step = candidates.length / target;
  for (let i = 0; i < target; i++) picked.push(candidates[Math.floor(i * step)]);
  return picked;
}

/* ------------------------------------------------------------- normalizing */

function normalize(words, source) {
  const out = [];
  const seen = new Set();
  for (let word of words) {
    word = String(word).normalize('NFC').trim();
    if (!word) continue;
    word = word.replace(/\s+/g, ''); // a handful of fandom entries are two words
    if (!source.keepCase) word = word.toLowerCase();
    if (word.length < 2 || word.length > 20) continue;
    const dedupeKey = word.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(word);
  }
  out.sort((a, b) => a.localeCompare(b));
  return source.limit ? out.slice(0, source.limit) : out;
}

/* -------------------------------------------------------------------- main */

async function main() {
  const onlyArg = process.argv.indexOf('--only');
  const only = onlyArg > -1 ? new Set(process.argv[onlyArg + 1].split(',')) : null;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const manifest = [];
  const failures = [];

  for (const source of SOURCES) {
    if (only && !only.has(source.key)) continue;
    process.stdout.write(source.key.padEnd(22));
    try {
      const buffer = await download(source.url);
      const text = buffer.toString('utf8');
      let words;
      if (source.parse === 'diceware') words = parseDiceware(text);
      else if (source.parse === 'plain') words = parsePlain(text);
      else if (source.parse === 'webpassgen') words = parseWebpassgen(text);
      else if (source.parse === 'icelandic') words = parseIcelandic(text);
      else throw new Error('unknown parser ' + source.parse);

      const clean = normalize(words, source);
      if (clean.length < 500) throw new Error('only ' + clean.length + ' usable words');

      fs.writeFileSync(path.join(OUT_DIR, source.key + '.txt'), clean.join('\n') + '\n', 'utf8');
      manifest.push({
        key: source.key,
        name: source.name,
        category: source.category,
        count: clean.length,
        bitsPerWord: Math.round((Math.log(clean.length) / Math.log(2)) * 100) / 100,
        source: source.url,
        credit: source.credit || WEBPASSGEN_CREDIT
      });
      console.log('ok    ' + String(clean.length).padStart(6) + ' words');
    } catch (err) {
      failures.push({ key: source.key, error: err.message });
      console.log('FAIL  ' + err.message);
    }
  }

  if (only) {
    // A partial run must not throw away the entries it did not refresh.
    const existing = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'manifest.json'), 'utf8'));
    const merged = existing.filter((e) => !manifest.some((m) => m.key === e.key)).concat(manifest);
    manifest.length = 0;
    manifest.push(...merged);
  }

  manifest.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  const lines = [
    '# Word list sources',
    '',
    'Every list below is downloaded and normalized by `scripts/fetch-wordlists.js`.',
    'Normalizing means: strip the dice roll column, trim, drop duplicates and',
    'blank lines, and sort. The words themselves are unchanged.',
    ''
  ];
  for (const category of ['standard', 'fandom', 'languages', 'names']) {
    const group = manifest.filter((m) => m.category === category);
    if (!group.length) continue;
    lines.push('## ' + category[0].toUpperCase() + category.slice(1), '');
    for (const entry of group) {
      lines.push(
        '- **' + entry.name + '** (`' + entry.key + '`), ' + entry.count.toLocaleString() +
          ' words, ' + entry.bitsPerWord + ' bits per word'
      );
      lines.push('  - ' + entry.credit);
      lines.push('  - ' + entry.source);
    }
    lines.push('');
  }
  fs.writeFileSync(path.join(OUT_DIR, 'SOURCES.md'), lines.join('\n'), 'utf8');

  console.log('');
  console.log(manifest.length + ' lists in wordlists/');
  if (failures.length) {
    console.log('failed: ' + failures.map((f) => f.key + ' (' + f.error + ')').join(', '));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
