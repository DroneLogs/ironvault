'use strict';

const crypto = require('crypto');
const wordlists = require('./wordlists');
const strength = require('./strength');

/* ---------------------------------------------------------- character pools */

const POOLS = {
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  lower: 'abcdefghijklmnopqrstuvwxyz',
  digits: '0123456789',
  symbols: '+-=_@#$%^&;:,.<>/~\\[](){}?!|*\'"',
  latin1:
    '¡¢£¤¥¦§¨©ª«¬®¯' +
    '°±²³´µ¶·¸¹º»¼½¾¿' +
    'ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏ' +
    'ÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞß' +
    'àáâãäåæçèéêëìíîï' +
    'ðñòóôõö÷øùúûüýþÿ'
};

const GROUP_ORDER = ['upper', 'lower', 'digits', 'symbols', 'latin1'];

const DIFFICULT_TO_READ = '0125lIOSZ;:,.[](){}!|';
const AMBIGUOUS = '{}[]()/\\\'"`~,;:.<>';

/* --------------------------------------------------------------- randomness */

function randomInt(max) {
  if (max <= 0) throw new Error('randomInt needs a positive bound');
  if (max === 1) return 0;
  // Rejection sampling, so every value is equally likely.
  const limit = Math.floor(0xffffffff / max) * max;
  let value;
  do {
    value = crypto.randomBytes(4).readUInt32BE(0);
  } while (value >= limit);
  return value % max;
}

function pick(list) {
  return list[randomInt(list.length)];
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

const log2 = (n) => Math.log(n) / Math.LN2;

/* -------------------------------------------------------------------- basic */

function buildGroups(config) {
  const excluded = new Set(String(config.excludedCharacters || '').split(''));
  const groups = [];

  for (const name of GROUP_ORDER) {
    if (!config.groups || !config.groups[name]) continue;
    let chars = POOLS[name].split('');
    if (config.easyReadOnly) chars = chars.filter((c) => !DIFFICULT_TO_READ.includes(c));
    if (config.nonAmbiguousOnly) chars = chars.filter((c) => !AMBIGUOUS.includes(c));
    chars = chars.filter((c) => !excluded.has(c));
    if (chars.length) groups.push({ name, chars });
  }

  return groups;
}

function generateBasic(config = {}) {
  const length = Math.max(4, Math.min(128, Number(config.length) || 22));
  const groups = buildGroups(config);

  if (!groups.length) {
    const err = new Error('Every character has been excluded. Turn a group back on.');
    err.code = 'NO_CHARACTERS';
    throw err;
  }

  const pool = groups.flatMap((g) => g.chars);
  const chars = [];
  let bits = 0;

  if (config.pickFromEveryGroup && groups.length <= length) {
    // One character from each group first, then fill from the whole pool and
    // shuffle. Entropy counts each draw from the set it was actually taken from.
    for (const group of groups) {
      chars.push(pick(group.chars));
      bits += log2(group.chars.length);
    }
    while (chars.length < length) {
      chars.push(pick(pool));
      bits += log2(pool.length);
    }
    shuffle(chars);
    // The arrangement of the seeded characters carries information too, but
    // counting it would overstate the guarantee, so it is left out.
  } else {
    for (let i = 0; i < length; i++) {
      chars.push(pick(pool));
    }
    bits = length * log2(pool.length);
  }

  const password = chars.join('');
  return {
    password,
    strength: strength.fromEntropy(password, bits),
    poolSize: pool.length,
    groupsUsed: groups.map((g) => g.name)
  };
}

/* ----------------------------------------------------------------- diceware */

const LEET_PRO = {
  a: '4', b: '|3', c: '(', d: '|)', e: '3', f: '|=', g: '6', h: '|-|', i: '|',
  j: '9', k: '|<', l: '1', m: '|v|', n: '|/|', o: '0', p: '|*', q: '0,',
  r: '|2', s: '5', t: '7', u: '|_|', v: '|/', w: '|/|/', x: '><', y: '`/', z: '2'
};

const LEET_BASIC = {
  a: '4', e: '3', g: '6', i: '|', j: '9', l: '1', o: '0', s: '5', t: '7', z: '2'
};

function applyCasing(word, casing) {
  switch (casing) {
    case 'lower':
      return word.toLowerCase();
    case 'upper':
      return word.toUpperCase();
    case 'title':
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    case 'random': {
      // Flip the case of half the letters, chosen at random.
      const chars = word.split('');
      const flips = Math.floor(chars.length / 2);
      const positions = shuffle(chars.map((_, i) => i)).slice(0, flips);
      for (const index of positions) {
        chars[index] =
          chars[index] === chars[index].toUpperCase()
            ? chars[index].toLowerCase()
            : chars[index].toUpperCase();
      }
      return chars.join('');
    }
    default:
      return word;
  }
}

function casingBits(casing, word) {
  if (casing !== 'random') return 0;
  const flips = Math.floor(word.length / 2);
  if (flips < 1) return 0;
  // Choosing which positions to flip is the only random part.
  let combinations = 1;
  for (let i = 0; i < flips; i++) combinations *= (word.length - i) / (i + 1);
  return Math.max(0, log2(combinations));
}

function leetify(word, level) {
  if (!level || level === 'none') return word;
  const all = level === 'pro-all' || level === 'basic-all';
  if (!all && randomInt(10) < 6) return word; // roughly 40% of words get treated
  const map = level.startsWith('pro') ? LEET_PRO : LEET_BASIC;
  return word
    .split('')
    .map((c) => map[c.toLowerCase()] || c)
    .join('');
}

function sprinkle(text, character) {
  const index = randomInt(text.length + 1);
  return text.slice(0, index) + character + text.slice(index);
}

function generateDiceware(config = {}) {
  const wordCount = Math.max(1, Math.min(16, Number(config.wordCount) || 6));
  const listKeys = Array.isArray(config.wordLists) && config.wordLists.length
    ? config.wordLists
    : ['eff-large'];
  const pool = wordlists.pool(listKeys);

  if (pool.length < 128) {
    const err = new Error('That word list is too small to build a passphrase from.');
    err.code = 'LIST_TOO_SMALL';
    throw err;
  }

  const separator = config.separator === undefined ? '-' : String(config.separator);
  const casing = config.casing || 'title';
  const leet = config.leetspeak || 'none';

  let bits = wordCount * log2(pool.length);
  const words = [];
  for (let i = 0; i < wordCount; i++) {
    const raw = pick(pool);
    bits += casingBits(casing, raw);
    words.push(leetify(applyCasing(raw, casing), leet));
  }

  let passphrase = words.join(separator);

  if (config.salt && config.salt !== 'none') {
    const saltLength = randomInt(4) + 1;
    const salt = generateBasic({
      length: Math.max(4, saltLength),
      groups: { upper: true, lower: true, digits: true, symbols: true },
      easyReadOnly: true,
      nonAmbiguousOnly: true,
      pickFromEveryGroup: false
    }).password.slice(0, saltLength);

    bits += saltLength * log2(66) + log2(4); // characters, plus the length choice

    if (config.salt === 'prefix') {
      passphrase = salt + separator + passphrase;
    } else if (config.salt === 'suffix') {
      passphrase = passphrase + separator + salt;
    } else {
      for (const character of salt) {
        bits += log2(passphrase.length + 1);
        passphrase = sprinkle(passphrase, character);
      }
    }
  }

  const additions = [
    ['addLowercase', 'lower'],
    ['addUppercase', 'upper'],
    ['addNumber', 'digits'],
    ['addSymbol', 'symbols'],
    ['addLatin1', 'latin1']
  ];
  for (const [flag, poolName] of additions) {
    if (!config[flag]) continue;
    const chars = POOLS[poolName];
    bits += log2(chars.length) + log2(passphrase.length + 1);
    passphrase = sprinkle(passphrase, chars[randomInt(chars.length)]);
  }

  return {
    password: passphrase,
    strength: strength.fromEntropy(passphrase, bits),
    poolSize: pool.length,
    bitsPerWord: Math.round(log2(pool.length) * 100) / 100,
    wordCount
  };
}

function generate(config = {}) {
  return config.algorithm === 'diceware' ? generateDiceware(config) : generateBasic(config);
}

/* -------------------------------------------------------- username suggestions */

function firstName() {
  const list = wordlists.names('first');
  return list.length ? pick(list) : 'Alex';
}

function surname() {
  const list = wordlists.names('surname');
  return list.length ? pick(list) : 'Rivera';
}

function titleCase(word) {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * Four shapes: dotted handle, full name, bare first name, and a single random
 * word.
 *
 * There was a fifth that built an email address by sticking a random number
 * between a first name and a real provider's domain. It was removed. Nothing
 * created that mailbox, the domain belonged to somebody else, and the address
 * it handed you could easily be a stranger's real one. A suggester that has to
 * be explained away is not a feature.
 *
 * Real forwarding addresses come from a provider that issues them, Apple Hide
 * My Email, DuckDuckGo, SimpleLogin, or a catch-all on a domain you own. That
 * means an account and an API call, and it is the only honest way to do this.
 */
function generateUsernames() {
  const word = pick(wordlists.pool(['eff-large'])).toLowerCase();
  return [
    { type: 'handle', value: (firstName() + '.' + surname()).toLowerCase() },
    { type: 'name', value: titleCase(firstName()) + ' ' + titleCase(surname()) },
    { type: 'first', value: titleCase(firstName()) },
    { type: 'word', value: word }
  ];
}

module.exports = {
  generate,
  generateBasic,
  generateDiceware,
  generateUsernames,
  POOLS,
  DIFFICULT_TO_READ,
  AMBIGUOUS,
  randomInt
};
