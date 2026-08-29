'use strict';

/**
 * Builds wordlists/fandom-lotr.txt from The One Wiki to Rule Them All.
 *
 * The EFF never made a Tolkien list. The other four fandom lists in this app are
 * theirs, built in 2018 by ranking words from a fan wiki and filtering the
 * result, so this follows the same method against the same kind of source.
 *
 * The wiki is CC BY-SA, which the finished list inherits: it must carry
 * attribution and stay share-alike. That is recorded in wordlists/SOURCES.md and
 * in LICENSING.md, and it is a condition on the list rather than on this app.
 *
 * Two passes. Page titles first, because on a fandom wiki the titles are the
 * vocabulary somebody actually wants: people, places, things, battles. Then
 * article text, ranked by how often a word appears, to fill out the rest with
 * words that are recognisably of the setting rather than merely English.
 *
 *   node scripts/fetch-lotr-wordlist.js          write the list
 *   node scripts/fetch-lotr-wordlist.js --dry    report what it would write
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const API = 'https://lotr.fandom.com/api.php';
const OUT = path.join(__dirname, '..', 'wordlists', 'fandom-lotr.txt');
const TARGET = 4000;
const DRY = process.argv.includes('--dry');

/**
 * The wiki documents the films and the people who made them alongside the
 * world itself. A page in one of these categories is about our world, not
 * Middle-earth, and harvesting it fills the list with surnames off a cast
 * sheet. The page is skipped whole rather than filtered word by word, because
 * the giveaway is what the article is about, not what any single word is.
 */
const REAL_WORLD = /actor|actress|cast|crew|portray|film|movie|video game|book|novel|author|writer|composer|award|company|studio|publisher|real[ -]?world|behind the scenes|people|births|deaths|artist|musician|director|producer/i;

function aboutOurWorld(categories) {
  for (const category of categories || []) {
    if (REAL_WORLD.test(String(category.title || '').replace(/^Category:/, ''))) return true;
  }
  return false;
}

/* Words a password should not be built from: too common to feel like the
   setting, or too generic to be worth a slot in only four thousand. */
const STOPWORDS = new Set(
  ('the and for are but not you all any can her was one our out day get has him his how man new now old see two way who boy did its let put say she too use dad mom '
    + 'that this with from they have been were will would could should there their them then than when what which while about after also into over under more most '
    + 'some such only other same many much just like made make made take took come came give gave know knew think thought said says tell told want went being does '
    + 'doing done each even every from here itself life list long look made main need never next none once part page real said seen since still thing time upon very '
    + 'well were what where whose wiki work year years first second third fourth fifth article category template file image user talk redirect stub disambiguation '
    + 'list lists index chapter chapters volume volumes book books film films movie movies series season episode episodes video game games appendix appendices '
    + 'character characters people places events unnamed unknown various several including include included references reference source sources note notes'
  ).split(/\s+/)
);

/**
 * What leaks through the category filter, found by reading the finished list.
 * Redirect titles carry no categories to judge them by, and prose mentions the
 * publishing world constantly, so these arrive however carefully the pages are
 * chosen. March and May are deliberately absent: they are ordinary words and
 * Tolkien uses both.
 */
const OUR_WORLD_WORDS = new Set(
  ('january february april june july august september october november december '
    + 'bbc mesbg bfme ccg dvd cgi imdb isbn cinema trilogy edition editions journal magazine '
    + 'press radio screen website youtube twitter facebook podcast online internet publisher '
    + 'published publication copyright trademark featured unidentified miscellaneous'
  ).split(/\s+/)
);

function get(params) {
  const url = API + '?' + new URLSearchParams({ ...params, format: 'json' }).toString();
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      { headers: { 'User-Agent': 'propolis-wordlist-builder (https://github.com/DroneLogs/ironvault)' }, timeout: 45000 },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode + ' for ' + url));
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(new Error('bad JSON: ' + err.message));
          }
        });
      }
    );
    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy();
      reject(new Error('timed out: ' + url));
    });
  });
}

/** Strips accents so Eärendil is typeable as earendil. */
function plain(word) {
  return word
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

function usable(word) {
  if (!/^[a-z]{3,12}$/.test(word)) return false;
  if (STOPWORDS.has(word)) return false;
  if (OUR_WORLD_WORDS.has(word)) return false;
  return true;
}

function harvest(text, into, weight) {
  for (const raw of String(text || '').split(/[^A-Za-zÀ-ɏ]+/)) {
    const word = plain(raw);
    if (!usable(word)) continue;
    into.set(word, (into.get(word) || 0) + weight);
  }
}

async function allTitles(kind) {
  const titles = [];
  let from = null;
  do {
    const page = await get({
      action: 'query',
      list: 'allpages',
      apnamespace: 0,
      aplimit: 500,
      apfilterredir: kind,
      ...(from ? { apcontinue: from } : {})
    });
    for (const item of page.query.allpages) titles.push(item.title);
    from = page.continue ? page.continue.apcontinue : null;
    process.stdout.write('\r  ' + kind + ': ' + titles.length);
  } while (from);
  process.stdout.write('\n');
  return titles;
}

/**
 * A redirect title is an alternate name for something: Strider for Aragorn,
 * Elessar for the same man again. That is the best vocabulary on the wiki and
 * it is free, one title per page and no article to read. There are no
 * categories on a redirect to judge it by, so only the unmistakable real world
 * markers are excluded rather than the whole category test.
 */
const REAL_WORLD_TITLE = /\((film|movie|actor|actress|video game|game|soundtrack|book|novel|album|song|series|documentary)\)/i;

async function extractsFor(titles, counts) {
  let done = 0;
  let skipped = 0;
  for (let i = 0; i < titles.length; i += 20) {
    const batch = titles.slice(i, i + 20);
    try {
      const page = await get({
        action: 'query',
        prop: 'extracts|categories',
        explaintext: 1,
        exintro: 1,
        exlimit: 20,
        cllimit: 'max',
        titles: batch.join('|')
      });
      for (const entry of Object.values(page.query.pages || {})) {
        if (aboutOurWorld(entry.categories)) {
          skipped += 1;
          continue;
        }
        // A title is worth more than a passing mention in prose.
        harvest(entry.title, counts, 8);
        harvest(entry.extract, counts, 1);
      }
    } catch (err) {
      process.stdout.write('\n  skipped a batch: ' + err.message + '\n');
    }
    done += batch.length;
    process.stdout.write('\r  articles read: ' + done + ' / ' + titles.length);
  }
  process.stdout.write('\n');
  console.log('  skipped as real world: ' + skipped);
}

async function main() {
  console.log('Building a Tolkien word list from ' + API);
  console.log('The wiki is CC BY-SA. So is the list this writes.\n');

  const titles = await allTitles('nonredirects');
  const aliases = await allTitles('redirects');
  const counts = new Map();

  let aliasesUsed = 0;
  for (const alias of aliases) {
    if (REAL_WORLD_TITLE.test(alias)) continue;
    harvest(alias, counts, 8);
    aliasesUsed += 1;
  }
  console.log('  alternate names harvested: ' + aliasesUsed);

  await extractsFor(titles, counts);
  console.log('  unique words harvested: ' + counts.size);

  const ranked = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TARGET)
    .map(([word]) => word)
    .sort();

  console.log('\n  writing ' + ranked.length + ' words');
  console.log('  bits per word: ' + (Math.log(ranked.length) / Math.LN2).toFixed(2));
  console.log('  sample: ' + ranked.slice(0, 12).join(', '));

  if (DRY) {
    console.log('\n  --dry, nothing written');
    return;
  }
  fs.writeFileSync(OUT, ranked.join('\n') + '\n', 'utf8');
  console.log('  wrote ' + OUT);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
