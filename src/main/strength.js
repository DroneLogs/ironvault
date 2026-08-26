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

  return { bits: Math.max(0, bits), issues };
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

function build(password, bits, issues) {
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
    issues: issues || []
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
  const { bits, issues } = estimateEntropy(text);
  return build(text, bits, issues);
}

module.exports = { estimate, fromEntropy, crackTime, categoryFor, GUESSES_PER_SECOND };
