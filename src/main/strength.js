'use strict';

/**
 * Password strength, reported the way Strongbox reports it:
 *
 *   Strong (22 / 131.1 bits / >100m years)
 *
 * The first number is the character count, the second is entropy in bits, and
 * the third is how long an offline attacker would take at a billion guesses a
 * second. Generated passwords report the entropy the generator actually spent;
 * typed passwords get an estimate.
 */

const wordlists = require('./wordlists');

const GUESSES_PER_SECOND = 1e9;

const SECONDS_IN_HOUR = 60 * 60;
const SECONDS_IN_DAY = 24 * SECONDS_IN_HOUR;
const SECONDS_IN_YEAR = SECONDS_IN_DAY * 365;
const SECONDS_IN_CENTURY = 100 * SECONDS_IN_YEAR;
const SECONDS_IN_THOUSAND_YEARS = 1000 * SECONDS_IN_YEAR;
const SECONDS_IN_MILLION_YEARS = 1e6 * SECONDS_IN_YEAR;

const CATEGORIES = [
  { max: 28, label: 'Very Weak', level: 0 },
  { max: 36, label: 'Weak', level: 1 },
  { max: 60, label: 'Mediocre', level: 2 },
  { max: 128, label: 'Strong', level: 3 },
  { max: 192, label: 'Very Strong', level: 4 },
  { max: Infinity, label: 'Overkill', level: 5 }
];

const COMMON = new Set([
  'password', 'passw0rd', 'password1', '123456', '12345678', '123456789', 'qwerty',
  'abc123', 'letmein', 'monkey', 'dragon', 'iloveyou', 'admin', 'welcome', 'login',
  'princess', 'sunshine', 'football', 'baseball', 'master', 'shadow', 'trustno1',
  'superman', 'batman', 'starwars', 'whatever', 'summer', 'winter', 'hunter2',
  'qwerty123', '1q2w3e4r', 'zaq12wsx', 'changeme'
]);

const KEYBOARD_RUNS = [
  'qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890', 'abcdefghijklmnopqrstuvwxyz'
];

/* ------------------------------------------------------------- passphrases */

/**
 * A passphrase is not a random string of characters, and scoring it as one is
 * wrong in the direction that matters. Six words from the EFF list are 77.5
 * bits however many letters they run to; counting the characters says 338 and
 * calls it Overkill. An attacker who suspects a word list searches the words,
 * so the honest number is the smaller one, and this goes looking for it.
 *
 * Only the lists the generator can draw from are searched, and the smallest
 * list that covers every word wins, because that is the cheapest attack
 * available to somebody guessing.
 *
 * Words run together with no separator are not detected. Splitting
 * correcthorsebatterystaple needs segmentation, and a wrong split would
 * understate a real password, which is the one error worse than this one.
 */
/**
 * Every list the generator offers, taken from the catalogue rather than typed
 * out here. A hardcoded eight left the sixteen fandom and language lists
 * invisible, so a six word Star Wars phrase worth 71.8 bits was still being
 * reported as 295.8: the same bug, surviving in two thirds of the lists.
 */
let dictionaries = null;

function loadDictionaries() {
  if (dictionaries) return dictionaries;
  dictionaries = [];
  for (const entry of wordlists.catalogue()) {
    const key = entry && entry.key;
    if (!key) continue;
    try {
      if (!wordlists.has(key)) continue;
      const list = wordlists.words(key);
      if (!list.length) continue;
      dictionaries.push({ key, size: list.length, set: new Set(list.map((w) => w.toLowerCase())) });
    } catch {
      /* a list that will not load is simply one fewer place to look */
    }
  }
  dictionaries.sort((a, b) => a.size - b.size);

  // Words picked from more than one list, which the generator can do, are not
  // covered by any single list. The union is the honest fallback: still far
  // below what counting the characters would say, and above any one list.
  const union = new Set();
  for (const d of dictionaries) for (const w of d.set) union.add(w);
  if (union.size) dictionaries.push({ key: 'every list', size: union.size, set: union });

  return dictionaries;
}

/**
 * What the words cost, plus what the characters around them cost. The
 * separator is charged once rather than per occurrence, since five hyphens in
 * a row is one decision, not five. Casing is charged nothing: Title Case is a
 * pattern, and there is no way from here to tell it from a random one.
 */
/**
 * Greedy longest match first, so a list entry that contains the separator is
 * read as the one word it is. absent-mindedly is a single Harry Potter entry,
 * and splitting it in two counted it twice and reported more entropy than the
 * phrase actually cost. Fewer words is also the lower number, which is the side
 * to err on.
 */
function segmentCount(tokens, joiner, set) {
  let index = 0;
  let words = 0;
  while (index < tokens.length) {
    let matched = 0;
    for (let span = Math.min(4, tokens.length - index); span >= 1; span--) {
      if (set.has(tokens.slice(index, index + span).join(joiner))) {
        matched = span;
        break;
      }
    }
    if (!matched) return null;
    index += matched;
    words += 1;
  }
  return words;
}

/**
 * What the words cost, plus what the characters around them cost.
 *
 * Tokens are runs of letters in any script, not just A to Z, because half the
 * lists are not English and splitting Þórður or Grüße down the middle of a word
 * means never recognising it.
 *
 * Two letter tokens are allowed even though the original Diceware and Beale
 * lists are full of fragments like xk and mq. Reading a random password as a
 * phrase understates it, which is harmless; failing to read a real phrase
 * overstates it, which is the mistake this whole function exists to prevent.
 * Given the choice, take the safe error.
 *
 * The separator is charged nothing. Somebody guessing tries a hyphen, a dot, a
 * space and nothing at all, which is worth a bit or two, and rounding that down
 * keeps this at or below the exact figure the generator reports for the same
 * phrase. Anything beyond the separator, an added digit or symbol, is charged in
 * full. Casing is charged nothing: Title Case is a pattern, and there is no way
 * from here to tell it from a random one.
 */
function passphraseEntropy(password) {
  const tokens = password.split(/[^\p{L}]+/u).filter(Boolean);
  if (tokens.length < 2) return null;
  if (tokens.some((w) => w.length < 2)) return null;

  const letterCount = tokens.reduce((sum, w) => sum + w.length, 0);
  if (letterCount < password.length * 0.6) return null;

  const extras = password.replace(/\p{L}+/gu, '');
  const counts = new Map();
  for (const ch of extras) counts.set(ch, (counts.get(ch) || 0) + 1);
  let separator = '';
  let commonest = 0;
  for (const [ch, n] of counts) {
    if (n > commonest) {
      commonest = n;
      separator = ch;
    }
  }

  const lower = tokens.map((w) => w.toLowerCase());
  let covering = null;
  let words = 0;
  for (const dictionary of loadDictionaries()) {
    const count = segmentCount(lower, separator, dictionary.set);
    if (count) {
      covering = dictionary;
      words = count;
      break;
    }
  }
  if (!covering) return null;

  let extraBits = 0;
  if (extras.length) {
    const beyondSeparator = extras.length - commonest;
    extraBits = beyondSeparator * (Math.log(poolSizeFor(extras)) / Math.LN2);
  }

  return {
    bits: words * (Math.log(covering.size) / Math.LN2) + extraBits,
    words,
    list: covering.key,
    listSize: covering.size
  };
}

/* --------------------------------------------------------------- estimation */

function poolSizeFor(password) {
  let size = 0;
  if (/[a-z]/.test(password)) size += 26;
  if (/[A-Z]/.test(password)) size += 26;
  if (/[0-9]/.test(password)) size += 10;
  if (/[!@#$%^&*()`~\-_=+[\]{}\\|;:'",<.>/?]/.test(password)) size += 32;
  if (/ /.test(password)) size += 1;
  if (/[^\x20-\x7e]/.test(password)) size += 96;
  return size || 1;
}

function hasRun(password, minLength = 4) {
  const lower = password.toLowerCase();
  for (const run of KEYBOARD_RUNS) {
    for (let i = 0; i + minLength <= run.length; i++) {
      const slice = run.slice(i, i + minLength);
      if (lower.includes(slice)) return true;
      if (lower.includes([...slice].reverse().join(''))) return true;
    }
  }
  return false;
}

function repeatPenalty(password) {
  if (!password.length) return 0;
  const unique = new Set(password.split('')).size;
  const ratio = unique / password.length;
  if (ratio >= 0.7) return 0;
  return Math.round((0.7 - ratio) * 40);
}

/** Entropy estimate for a password somebody typed, rather than one we made. */
function estimateEntropy(password) {
  const issues = [];
  let bits = password.length * (Math.log(poolSizeFor(password)) / Math.LN2);
  const lower = password.toLowerCase();
  const letters = lower.replace(/[^a-z]/g, '');

  if (COMMON.has(lower) || (letters.length > 3 && COMMON.has(letters))) {
    bits = Math.min(bits, 10);
    issues.push('Contains a very common password');
  }
  if (hasRun(password)) {
    bits -= 12;
    issues.push('Contains a keyboard or alphabet run');
  }
  const repeats = repeatPenalty(password);
  if (repeats) {
    bits -= repeats;
    issues.push('Repeats the same few characters');
  }
  if (/^\d+$/.test(password)) {
    bits -= 10;
    issues.push('Digits only');
  }
  if (/(19|20)\d\d/.test(password)) {
    bits -= 5;
    issues.push('Contains a year');
  }
  if (password.length < 8) issues.push('Shorter than 8 characters');

  // An attacker takes the cheapest route, so the estimate has to as well.
  const phrase = passphraseEntropy(password);
  let basis = null;
  if (phrase && phrase.bits < bits) {
    bits = phrase.bits;
    basis = phrase;
    issues.push(
      'Reads as ' + phrase.words + ' words from a published list, so it is worth what the words cost, not what the letters do'
    );
  }

  return { bits: Math.max(0, bits), issues, basis };
}

/* ------------------------------------------------------------- presentation */

function categoryFor(bits) {
  return CATEGORIES.find((c) => bits < c.max) || CATEGORIES[CATEGORIES.length - 1];
}

function crackTime(bits, guessesPerSecond = GUESSES_PER_SECOND) {
  // Half the search space on average, so 2^(bits - 1) guesses.
  const seconds = Math.pow(2, bits - 1) / guessesPerSecond;

  const millionYears = seconds / SECONDS_IN_MILLION_YEARS;
  if (millionYears > 100) return '>100m years';
  if (millionYears > 1) return Math.floor(millionYears) + 'm years';

  const thousandYears = Math.floor(seconds / SECONDS_IN_THOUSAND_YEARS);
  if (thousandYears > 9) return thousandYears + 'k years';

  const centuries = Math.floor(seconds / SECONDS_IN_CENTURY);
  if (centuries > 0) return centuries + (centuries === 1 ? ' century' : ' centuries');

  const years = Math.floor(seconds / SECONDS_IN_YEAR);
  if (years > 0) return years + (years === 1 ? ' year' : ' years');

  const days = Math.floor(seconds / SECONDS_IN_DAY);
  if (days > 0) return days + (days === 1 ? ' day' : ' days');

  const hours = Math.floor(seconds / SECONDS_IN_HOUR);
  if (hours > 0) return hours + (hours === 1 ? ' hour' : ' hours');

  const minutes = Math.floor(seconds / 60);
  if (minutes > 0) return minutes + 'm ' + Math.floor(seconds % 60) + 's';

  if (seconds >= 1) return Math.floor(seconds) + 's';
  return 'instantly';
}

function build(password, bits, issues, basis) {
  const text = String(password || '');
  const rounded = Math.round(bits * 10) / 10;
  const category = categoryFor(bits);
  const time = crackTime(bits);

  return {
    length: text.length,
    bits: rounded,
    entropy: Math.round(bits), // whole number, for callers that want one
    level: category.level,
    score: Math.min(4, category.level), // the old 0 to 4 scale, used by the audit
    label: category.label,
    crackTime: time,
    summary: `${category.label} (${text.length} / ${rounded.toFixed(1)} bits / ${time})`,
    fraction: Math.min(bits / 128, 1), // meter fill, saturating at 128 bits
    issues: issues || [],
    // Which reading produced the number, for anything that wants to say so.
    basis: basis ? 'words' : 'characters',
    words: basis ? basis.words : 0,
    wordList: basis ? basis.list : null
  };
}

/** For a password we generated: the entropy is known exactly. */
function fromEntropy(password, bits) {
  return build(password, Math.max(0, bits), []);
}

/** For a password somebody typed, or one already stored in the database. */
function estimate(password) {
  const text = String(password || '');
  if (!text) return build('', 0, ['No password set']);
  const { bits, issues, basis } = estimateEntropy(text);
  return build(text, bits, issues, basis);
}

module.exports = { estimate, fromEntropy, crackTime, categoryFor, GUESSES_PER_SECOND };
