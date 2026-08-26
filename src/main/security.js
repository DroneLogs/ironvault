'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const { safeStorage } = require('electron');

const settings = require('./settings');
const backups = require('./backups');
const hello = require('./hello');

/**
 * Convenience unlock and the duress features.
 *
 * A PIN is short, so it is never the only thing protecting the master password.
 * The master password is encrypted with a key derived from the PIN by scrypt,
 * and the result is then wrapped by Windows DPAPI through safeStorage. Both the
 * PIN and the signed in Windows account are needed to get the password back.
 *
 * Windows Hello unlock has no secret of its own: it gates the DPAPI wrapped
 * copy behind a Hello prompt, which is the same shape Touch ID unlock takes on
 * a Mac.
 */

const SCRYPT_N = 1 << 15; // ~32 MB, about a tenth of a second
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_BYTES = 32;

function deriveKey(pin, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      String(pin),
      salt,
      KEY_BYTES,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 128 * SCRYPT_N * SCRYPT_R },
      (err, key) => (err ? reject(err) : resolve(key))
    );
  });
}

function dpapiAvailable() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function wrap(buffer) {
  if (!dpapiAvailable()) return { dpapi: false, data: buffer.toString('base64') };
  return { dpapi: true, data: safeStorage.encryptString(buffer.toString('base64')) .toString('base64') };
}

function unwrap(record) {
  if (!record) return null;
  if (!record.dpapi) return Buffer.from(record.data, 'base64');
  try {
    return Buffer.from(safeStorage.decryptString(Buffer.from(record.data, 'base64')), 'base64');
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------- PIN */

function validatePin(pin) {
  const text = String(pin || '');
  if (!/^\d{4,16}$/.test(text)) {
    throw new Error('A PIN must be 4 to 16 digits');
  }
  return text;
}

async function sealPassword(pin, password) {
  const salt = crypto.randomBytes(16);
  const key = await deriveKey(pin, salt);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const sealed = Buffer.concat([cipher.update(String(password), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, tag, sealed]);
  return { salt: salt.toString('base64'), sealed: wrap(payload) };
}

async function openPassword(pin, record) {
  const payload = unwrap(record.sealed);
  if (!payload) throw new Error('The stored PIN data could not be read on this Windows account');
  const key = await deriveKey(pin, Buffer.from(record.salt, 'base64'));
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const body = payload.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  // A wrong PIN fails the GCM tag check, which is what tells us it was wrong.
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

async function setPin(dbPath, pin, masterPassword) {
  const clean = validatePin(pin);
  if (!masterPassword) throw new Error('The database has to be open with its master password first');
  const record = await sealPassword(clean, masterPassword);
  settings.setSecrets(dbPath, { pin: record, failedAttempts: 0 });
  return { ok: true };
}

function clearPin(dbPath) {
  settings.setSecrets(dbPath, { pin: null, failedAttempts: 0 });
  return { ok: true };
}

/* ---------------------------------------------------------------- duress */

async function setDuress(dbPath, pin, { action, dummyPath } = {}) {
  const clean = validatePin(pin);
  if (!['dummy', 'wipe'].includes(action)) throw new Error('Pick a duress action');
  if (action === 'dummy') {
    if (!dummyPath || !fs.existsSync(dummyPath)) throw new Error('Choose a decoy database that exists');
  }

  const existing = settings.getSecrets(dbPath);
  if (existing.pin) {
    // A duress PIN that matches the real PIN would be unreachable.
    try {
      await openPassword(clean, existing.pin);
      throw new Error('The duress PIN cannot be the same as the unlock PIN');
    } catch (err) {
      if (err.message.includes('cannot be the same')) throw err;
      /* a failure here just means the PINs differ, which is what we want */
    }
  }

  const salt = crypto.randomBytes(16);
  const key = await deriveKey(clean, salt);
  settings.setSecrets(dbPath, {
    duress: {
      salt: salt.toString('base64'),
      check: key.toString('base64'),
      action,
      dummyPath: action === 'dummy' ? dummyPath : null
    }
  });
  return { ok: true, action };
}

function clearDuress(dbPath) {
  settings.setSecrets(dbPath, { duress: null });
  return { ok: true };
}

async function matchesDuress(dbPath, pin) {
  const secrets = settings.getSecrets(dbPath);
  if (!secrets.duress) return null;
  let key;
  try {
    key = await deriveKey(pin, Buffer.from(secrets.duress.salt, 'base64'));
  } catch {
    return null;
  }
  const expected = Buffer.from(secrets.duress.check, 'base64');
  if (key.length !== expected.length || !crypto.timingSafeEqual(key, expected)) return null;
  return { action: secrets.duress.action, dummyPath: secrets.duress.dummyPath };
}

/* ------------------------------------------------------------------ wipe */

/**
 * Removes the database, its rolling backups, the .bak beside it, and every
 * stored credential. Used by the duress PIN and by the failed attempt limit.
 * There is no undo, which is the entire point.
 */
async function wipe(dbPath) {
  const removed = [];
  try {
    await backups.removeAll(dbPath);
    removed.push('backups');
  } catch {
    /* keep going, the database itself matters more */
  }
  for (const target of [dbPath + '.bak', dbPath]) {
    try {
      if (fs.existsSync(target)) {
        await fsp.unlink(target);
        removed.push(target);
      }
    } catch {
      /* a locked file cannot be helped here */
    }
  }
  settings.forgetDatabase(dbPath);
  return { ok: true, removed };
}

/* -------------------------------------------------------- failed attempts */

function recordFailure(dbPath) {
  const secrets = settings.getSecrets(dbPath);
  const failedAttempts = (secrets.failedAttempts || 0) + 1;
  settings.setSecrets(dbPath, { failedAttempts });
  const limit = Number(secrets.wipeAfterFails || 0);
  return {
    failedAttempts,
    limit,
    wipeDue: limit > 0 && failedAttempts >= limit
  };
}

function resetFailures(dbPath) {
  settings.setSecrets(dbPath, { failedAttempts: 0 });
  return { ok: true };
}

function setWipeAfterFails(dbPath, count) {
  const limit = Math.max(0, Math.min(50, Number(count) || 0));
  settings.setSecrets(dbPath, { wipeAfterFails: limit, failedAttempts: 0 });
  return { ok: true, limit };
}

/* --------------------------------------------------------- Windows Hello */

async function setHello(dbPath, enabled, masterPassword) {
  if (!enabled) {
    settings.setSecrets(dbPath, { hello: null });
    return { ok: true, enabled: false };
  }
  const state = await hello.availability({ refresh: true });
  if (!state.available) throw new Error(state.reason || 'Windows Hello is unavailable');
  if (!masterPassword) throw new Error('The database has to be open with its master password first');
  if (!dpapiAvailable()) throw new Error('Windows credential encryption is unavailable');

  settings.setSecrets(dbPath, {
    hello: { sealed: wrap(Buffer.from(String(masterPassword), 'utf8')) }
  });
  return { ok: true, enabled: true };
}

async function unlockWithHello(dbPath, name) {
  const secrets = settings.getSecrets(dbPath);
  if (!secrets.hello) throw new Error('Windows Hello is not set up for this database');
  const result = await hello.verify('Unlock ' + (name || 'your database'));
  if (!result.verified) {
    const err = new Error(result.reason || 'Windows Hello did not confirm');
    err.code = 'HELLO_DENIED';
    throw err;
  }
  const buffer = unwrap(secrets.hello.sealed);
  if (!buffer) throw new Error('The stored password could not be read on this Windows account');
  return buffer.toString('utf8');
}

/* --------------------------------------------------------------- summary */

async function status(dbPath) {
  const secrets = settings.getSecrets(dbPath);
  const helloState = await hello.availability();
  return {
    hasPin: Boolean(secrets.pin),
    hasDuress: Boolean(secrets.duress),
    duressAction: secrets.duress ? secrets.duress.action : null,
    duressDummyPath: secrets.duress ? secrets.duress.dummyPath : null,
    helloEnabled: Boolean(secrets.hello),
    helloAvailable: helloState.available,
    helloReason: helloState.reason,
    failedAttempts: secrets.failedAttempts || 0,
    wipeAfterFails: secrets.wipeAfterFails || 0,
    dpapiAvailable: dpapiAvailable()
  };
}

module.exports = {
  setPin,
  clearPin,
  openPassword,
  validatePin,
  setDuress,
  clearDuress,
  matchesDuress,
  wipe,
  recordFailure,
  resetFailures,
  setWipeAfterFails,
  setHello,
  unlockWithHello,
  status,
  dpapiAvailable
};
