'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const brand = require('./brand');

const DEFAULTS = {
  databases: [],
  migrations: {},
  prefs: {
    clipboardClearSeconds: 30,
    autoLockMinutes: 5,
    lockOnMinimize: false,
    lockOnSuspend: true,
    concealPasswords: true,
    // Screen capture protection is a grant, not a stored mode: see capture.js.
    // Only the guard and how long a grant lasts are remembered.
    // YubiKey has never been run against real hardware, so it stays out of
    // the way until somebody deliberately turns it on. See yubikey.js.
    yubikeyBeta: false,
    // Email aliases come from a provider that issues them. The keys are
    // DPAPI sealed, never plain text: see aliases.js.
    aliasProvider: null,
    aliasKeys: {},
    // The old made up address, off unless deliberately asked for.
    allowInventedEmail: false,

    screenCaptureGuard: 'vault',
    screenCaptureYubikeySlot: 2,
    screenCaptureGrantMinutes: 60,
    screenCapturePassword: null,
    theme: 'blue-cb',
    appearance: 'dark',
    uiFont: 'system',
    zoom: 1,
    reduceMotion: false,
    strongFocus: false,
    bigTargets: false,
    highContrast: false,
    autoTypeHotkey: 'Control+Alt+A',
    keepBackups: 10,
    markdownNotes: true,
    masterPasswordReminderDays: 180,
    autoCheckUpdates: true,
    // A version the user chose to skip. Only silences the automatic
    // prompt; checking by hand still reports it.
    skippedUpdateVersion: null,
    updateFeedUrl: 'https://github.com/DroneLogs/ironvault/releases/latest/download/',
    updateReleasePageUrl: 'https://github.com/DroneLogs/ironvault/releases',
    generator: {
      algorithm: 'basic',

      length: 22,
      groups: { upper: true, lower: true, digits: true, symbols: true, latin1: false },
      easyReadOnly: true,
      nonAmbiguousOnly: true,
      pickFromEveryGroup: true,
      excludedCharacters: '',

      wordCount: 6,
      wordLists: ['eff-large'],
      separator: '-',
      casing: 'title',
      leetspeak: 'none',
      salt: 'none',
      addNumber: false,
      addUppercase: false,
      addLowercase: false,
      addSymbol: false,
      addLatin1: false
    }
  },
  window: { width: 1180, height: 760 }
};

let cache = null;
let filePath = null;

function file() {
  if (!filePath) filePath = path.join(app.getPath('userData'), 'settings.json');
  return filePath;
}

function deepMerge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return override ?? base;
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in base && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])
      ? deepMerge(base[k], v)
      : v;
  }
  return out;
}

/**
 * Profiles written before the update feed had a default carry an empty string,
 * which would otherwise win over the new default forever. Fill it in once, and
 * remember that we did, so clearing it on purpose still sticks.
 */
function migrate(settings) {
  if (!settings.migrations) settings.migrations = {};
  if (!settings.migrations.defaultUpdateFeed) {
    if (!settings.prefs.updateFeedUrl) settings.prefs.updateFeedUrl = DEFAULTS.prefs.updateFeedUrl;
    if (!settings.prefs.updateReleasePageUrl) {
      settings.prefs.updateReleasePageUrl = DEFAULTS.prefs.updateReleasePageUrl;
    }
    settings.migrations.defaultUpdateFeed = true;
  }

  // Palettes were named after products before the rename. Translate the keys.
  const palette = brand.migrateThemeKey(settings.prefs.theme);
  if (palette !== settings.prefs.theme) settings.prefs.theme = palette;

  return settings;
}

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(file(), 'utf8');
    cache = migrate(deepMerge(DEFAULTS, JSON.parse(raw)));
  } catch {
    cache = JSON.parse(JSON.stringify(DEFAULTS));
    cache.migrations = { defaultUpdateFeed: true };
  }
  return cache;
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(load(), null, 2), 'utf8');
  } catch (err) {
    console.error('Could not save settings:', err.message);
  }
}

function getPrefs() {
  return load().prefs;
}

function setPrefs(patch) {
  const s = load();
  s.prefs = deepMerge(s.prefs, patch || {});
  // An old palette key can arrive from anywhere. Normalise it on the way in.
  s.prefs.theme = brand.migrateThemeKey(s.prefs.theme);
  persist();
  return s.prefs;
}

function getWindowBounds() {
  return load().window;
}

function setWindowBounds(bounds) {
  load().window = bounds;
  persist();
}

function listDatabases() {
  return load().databases.filter((d) => d && d.path);
}

function findDatabase(dbPath) {
  const key = path.resolve(dbPath).toLowerCase();
  return load().databases.find((d) => path.resolve(d.path).toLowerCase() === key) || null;
}

function rememberDatabase(entry) {
  const s = load();
  const key = path.resolve(entry.path).toLowerCase();
  const existing = s.databases.find((d) => path.resolve(d.path).toLowerCase() === key);
  const record = {
    path: entry.path,
    name: entry.name || path.basename(entry.path, path.extname(entry.path)),
    keyFilePath: entry.keyFilePath || (existing ? existing.keyFilePath : null),
    lastOpened: Date.now(),
    quickUnlock: existing ? existing.quickUnlock : null
  };
  if ('quickUnlock' in entry) record.quickUnlock = entry.quickUnlock;
  if ('keyFilePath' in entry) record.keyFilePath = entry.keyFilePath;
  s.databases = [record, ...s.databases.filter((d) => path.resolve(d.path).toLowerCase() !== key)].slice(0, 20);
  persist();
  return record;
}

function forgetDatabase(dbPath) {
  const s = load();
  const key = path.resolve(dbPath).toLowerCase();
  s.databases = s.databases.filter((d) => path.resolve(d.path).toLowerCase() !== key);
  persist();
}

/** Merges a patch into one database's record, creating nothing if it is absent. */
function updateDatabase(dbPath, patch) {
  const s = load();
  const key = path.resolve(dbPath).toLowerCase();
  const rec = s.databases.find((d) => path.resolve(d.path).toLowerCase() === key);
  if (!rec) return null;
  Object.assign(rec, patch);
  persist();
  return rec;
}

/** Per database secrets: PIN, duress PIN, Windows Hello, failed attempt count. */
function getSecrets(dbPath) {
  const rec = findDatabase(dbPath);
  return (rec && rec.secrets) || {};
}

function setSecrets(dbPath, patch) {
  const s = load();
  const key = path.resolve(dbPath).toLowerCase();
  const rec = s.databases.find((d) => path.resolve(d.path).toLowerCase() === key);
  if (!rec) return {};
  rec.secrets = { ...(rec.secrets || {}), ...patch };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete rec.secrets[k];
  }
  persist();
  return rec.secrets;
}

function setQuickUnlock(dbPath, blob) {
  const s = load();
  const key = path.resolve(dbPath).toLowerCase();
  const rec = s.databases.find((d) => path.resolve(d.path).toLowerCase() === key);
  if (rec) {
    rec.quickUnlock = blob;
    persist();
  }
}

module.exports = {
  updateDatabase,
  getSecrets,
  setSecrets,
  getPrefs,
  setPrefs,
  getWindowBounds,
  setWindowBounds,
  listDatabases,
  findDatabase,
  rememberDatabase,
  forgetDatabase,
  setQuickUnlock,
  DEFAULTS
};
