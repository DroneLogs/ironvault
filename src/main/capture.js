'use strict';

/**
 * Screen capture protection, as a grant rather than a setting.
 *
 * Relaxing protection is the one change in this app that silently exposes every
 * password on screen, and it does so without any visible sign that it happened.
 * A checkbox is the wrong shape for that. Somebody demonstrates the app, forgets
 * to set it back, and every screen share afterwards leaks. Worse, anything that
 * can reach the settings file could relax it and never be noticed.
 *
 * So it works like sudo. You prove who you are, the relaxation lasts a bounded
 * time, and it is taken back the moment the vault closes. The resting state is
 * always full protection, and that is what the app starts in every time.
 *
 * Three things can end a grant, whichever comes first:
 *
 *   the timer          default an hour, the user can shorten or lengthen it
 *   the vault locking  always, and not configurable, because a locked vault
 *                      means the user has walked away
 *   quitting           the grant lives in memory and is never written down
 *
 * The guard is the master password by default, since anyone entitled to relax
 * this already knows it and it needs no setup. A separate password exists for
 * the case where somebody demonstrates the app but should not hold the master
 * key, and a YubiKey can stand in for either once one is bound.
 */

const crypto = require('crypto');

const settings = require('./settings');
const vault = require('./vault');

/**
 * Same scrypt parameters the PIN store uses, kept here rather than reaching
 * into security.js for one internal function. About a tenth of a second and
 * 32 MB, which is slow enough to make guessing this password pointless.
 */
const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_BYTES = 32;

// scrypt needs 128 * N * r * p bytes, and Node rejects a maxmem that merely
// equals that rather than exceeding it. The headroom is what makes it run.
const SCRYPT_MAXMEM = 128 * SCRYPT_N * SCRYPT_R * SCRYPT_P + (1 << 20);

function deriveKey(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      String(password),
      salt,
      KEY_BYTES,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM },
      (err, key) => (err ? reject(err) : resolve(key))
    );
  });
}

const MODES = ['never', 'unlessRevealed', 'always'];
const MIN_MINUTES = 1;
const MAX_MINUTES = 480; // eight hours, past which it is not a demonstration
const DEFAULT_MINUTES = 60;

/** Memory only, deliberately. A grant must not survive a restart. */
let grant = null;
let timer = null;
let listener = null;

function onChange(fn) {
  listener = fn;
}

function announce(reason) {
  if (listener) listener(status(), reason);
}

function grantMinutes() {
  const raw = Number(settings.getPrefs().screenCaptureGrantMinutes);
  if (!Number.isFinite(raw)) return DEFAULT_MINUTES;
  return Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(raw)));
}

function guardKind() {
  const kind = settings.getPrefs().screenCaptureGuard;
  return kind === 'password' || kind === 'yubikey' ? kind : 'vault';
}

/** What the window should actually do right now. */
function effectiveMode() {
  if (!grant) return 'never';
  if (Date.now() >= grant.expiresAt) {
    revoke('expired');
    return 'never';
  }
  return grant.mode;
}

function status() {
  const active = Boolean(grant) && Date.now() < grant.expiresAt;
  return {
    mode: active ? grant.mode : 'never',
    active,
    expiresAt: active ? grant.expiresAt : 0,
    remainingMs: active ? grant.expiresAt - Date.now() : 0,
    guard: guardKind(),
    grantMinutes: grantMinutes(),
    hasSeparatePassword: Boolean(settings.getPrefs().screenCapturePassword),
    // Offerable only once the user has opted into the beta. Whether a key is
    // actually plugged in is not asked here: that would probe the device every
    // time the settings screen opened.
    yubikeyAvailable: settings.getPrefs().yubikeyBeta === true
  };
}

function clearTimer() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

function revoke(reason) {
  if (!grant) return { ok: true, changed: false };
  clearTimer();
  grant = null;
  announce(reason || 'revoked');
  return { ok: true, changed: true };
}

/* ------------------------------------------------------------------ guards */

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length, so both sides are hashed to a fixed width first.
  const lh = crypto.createHash('sha256').update(left).digest();
  const rh = crypto.createHash('sha256').update(right).digest();
  return crypto.timingSafeEqual(lh, rh);
}

async function setSeparatePassword(password) {
  const value = String(password || '');
  if (value.length < 8) throw new Error('That password is too short. Use at least 8 characters.');
  const salt = crypto.randomBytes(16);
  const key = await deriveKey(value, salt);
  settings.setPrefs({
    screenCapturePassword: { salt: salt.toString('base64'), hash: key.toString('base64') }
  });
  return { ok: true };
}

function clearSeparatePassword() {
  settings.setPrefs({ screenCapturePassword: null });
  return { ok: true };
}

async function checkSeparatePassword(password) {
  const stored = settings.getPrefs().screenCapturePassword;
  if (!stored || !stored.salt || !stored.hash) {
    throw new Error('No separate password has been set for screen capture yet.');
  }
  const key = await deriveKey(String(password || ''), Buffer.from(stored.salt, 'base64'));
  return timingSafeEqualString(key.toString('base64'), stored.hash);
}

async function verifyGuard(credential) {
  const kind = guardKind();

  if (kind === 'vault') {
    if (!vault.isOpen()) {
      throw new Error('Open your database first. Screen capture is guarded by its master password.');
    }
    if (!vault.verifyMasterPassword(String(credential || ''))) {
      throw new Error('That is not the master password for this database.');
    }
    return true;
  }

  if (kind === 'password') {
    if (!(await checkSeparatePassword(credential))) {
      throw new Error('That is not the screen capture password.');
    }
    return true;
  }

  // YubiKey. Touching the key is the proof, so the challenge itself is the
  // check: if it answers, the right key is plugged in. Required lazily so a
  // missing or broken native module cannot stop the rest of this file loading.
  if (!settings.getPrefs().yubikeyBeta) {
    throw new Error('YubiKey support is off. Turn it on in Settings, under YubiKey.');
  }
  let yubikey;
  try {
    yubikey = require('./yubikey');
  } catch (err) {
    throw new Error('YubiKey support could not load: ' + err.message);
  }
  const slot = Number(settings.getPrefs().screenCaptureYubikeySlot) || 2;
  try {
    await yubikey.selfTest({ slot });
  } catch (err) {
    throw new Error('The YubiKey did not answer: ' + err.message);
  }
  return true;
}

/* ------------------------------------------------------------------- grant */

async function request({ mode, credential, minutes } = {}) {
  if (!MODES.includes(mode)) throw new Error('Unknown screen capture setting');
  if (mode === 'never') return revoke('set to never');

  await verifyGuard(credential);

  const requested = Number.isFinite(Number(minutes)) ? Number(minutes) : grantMinutes();
  const span = Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(requested)));

  clearTimer();
  grant = { mode, expiresAt: Date.now() + span * 60 * 1000 };
  timer = setTimeout(() => revoke('expired'), span * 60 * 1000);
  if (timer.unref) timer.unref();

  announce('granted');
  return status();
}

function setGuard(kind) {
  if (!['vault', 'password', 'yubikey'].includes(kind)) throw new Error('Unknown guard');
  settings.setPrefs({ screenCaptureGuard: kind });
  // Changing who holds the key ends any grant the old one authorised.
  revoke('guard changed');
  return status();
}

function setGrantMinutes(minutes) {
  // Not `|| DEFAULT`, because zero is falsy and would silently become an hour
  // rather than being clamped down to the floor like every other small number.
  const asked = Number(minutes);
  const wanted = Number.isFinite(asked) ? asked : DEFAULT_MINUTES;
  const span = Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(wanted)));
  settings.setPrefs({ screenCaptureGrantMinutes: span });
  return status();
}

module.exports = {
  onChange,
  status,
  effectiveMode,
  request,
  revoke,
  setGuard,
  setGrantMinutes,
  setSeparatePassword,
  clearSeparatePassword,
  MIN_MINUTES,
  MAX_MINUTES,
  DEFAULT_MINUTES
};
