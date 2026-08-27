'use strict';

const crypto = require('crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// Steam's authenticator uses five characters from its own alphabet instead of
// decimal digits, but the underlying HOTP maths is identical.
const STEAM_ALPHABET = '23456789BCDFGHJKMNPQRTVWXY';

function base32Decode(input) {
  const clean = String(input).toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('Invalid character in TOTP secret');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

function normalizeAlgorithm(algo) {
  const a = String(algo || 'SHA1').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (a === 'SHA256') return 'sha256';
  if (a === 'SHA512') return 'sha512';
  return 'sha1';
}

/**
 * Reads whichever TOTP convention the database happens to use. KeePassXC writes
 * an `otp` field holding an otpauth:// URI, KeeOTP writes `otp` as a query
 * string, and Tray TOTP splits it across `TOTP Seed` and `TOTP Settings`.
 */
function parseTotpConfig(fieldMap) {
  const get = (name) => {
    const v = fieldMap.get(name);
    if (v == null) return '';
    return typeof v === 'string' ? v : v.getText();
  };

  const otp = get('otp') || get('OTP') || get('TOTP');
  if (otp) {
    const trimmed = otp.trim();
    if (/^otpauth:\/\//i.test(trimmed)) {
      let url;
      try {
        url = new URL(trimmed);
      } catch {
        return null;
      }
      const p = url.searchParams;
      const secret = p.get('secret');
      if (!secret) return null;
      const label = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
      const issuer = p.get('issuer') || (label.includes(':') ? label.split(':')[0] : '');
      const steam =
        (p.get('encoder') || '').toLowerCase() === 'steam' || /^steam$/i.test(issuer.trim());
      return {
        secret,
        digits: steam ? 5 : parseInt(p.get('digits') || '6', 10) || 6,
        period: parseInt(p.get('period') || '30', 10) || 30,
        algorithm: normalizeAlgorithm(p.get('algorithm')),
        issuer,
        steam
      };
    }
    if (/key=/i.test(trimmed)) {
      const p = new URLSearchParams(trimmed);
      const secret = p.get('key') || p.get('secret');
      if (!secret) return null;
      return {
        secret,
        digits: parseInt(p.get('size') || p.get('digits') || '6', 10) || 6,
        period: parseInt(p.get('step') || p.get('period') || '30', 10) || 30,
        algorithm: normalizeAlgorithm(p.get('algorithm')),
        issuer: '',
        steam: false
      };
    }
    return {
      secret: trimmed,
      digits: 6,
      period: 30,
      algorithm: 'sha1',
      issuer: '',
      steam: false
    };
  }

  const seed = get('TOTP Seed');
  if (seed) {
    const settings = get('TOTP Settings');
    let period = 30;
    let digits = 6;
    let algorithm = 'sha1';
    let steam = false;
    if (settings) {
      const parts = settings.split(';').map((s) => s.trim());
      if (parts[0]) period = parseInt(parts[0], 10) || 30;
      if (parts[1]) {
        if (/^\d+$/.test(parts[1])) digits = parseInt(parts[1], 10) || 6;
        else if (/^s$/i.test(parts[1])) {
          // Tray TOTP writes "S" in the length slot for Steam.
          digits = 5;
          steam = true;
        }
      }
      const algoPart = parts.find((s) => /^sha/i.test(s));
      if (algoPart) algorithm = normalizeAlgorithm(algoPart);
    }
    return { secret: seed.trim(), digits, period, algorithm, issuer: '', steam };
  }

  return null;
}

function generateCode(config, atMs = Date.now()) {
  const key = base32Decode(config.secret);
  if (!key.length) throw new Error('Empty TOTP secret');
  const counter = Math.floor(atMs / 1000 / config.period);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac(config.algorithm, key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  const secondsLeft = config.period - Math.floor((atMs / 1000) % config.period);

  let code;
  if (config.steam) {
    let value = binary;
    code = '';
    for (let i = 0; i < 5; i++) {
      code += STEAM_ALPHABET[value % STEAM_ALPHABET.length];
      value = Math.floor(value / STEAM_ALPHABET.length);
    }
  } else {
    code = String(binary % Math.pow(10, config.digits)).padStart(config.digits, '0');
  }

  return {
    code,
    period: config.period,
    secondsLeft,
    issuer: config.issuer || '',
    steam: Boolean(config.steam)
  };
}

function buildOtpAuthUri({ secret, issuer, account, digits, period, algorithm, steam }) {
  const label = issuer ? `${issuer}:${account || ''}` : account || 'Propolis';
  const params = new URLSearchParams({
    secret: String(secret).toUpperCase().replace(/[\s-]/g, ''),
    digits: String(steam ? 5 : digits || 6),
    period: String(period || 30),
    algorithm: (algorithm || 'sha1').toUpperCase()
  });
  if (issuer) params.set('issuer', issuer);
  if (steam) params.set('encoder', 'steam');
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

/** Validates a secret before it is written to an entry. */
function validateSecret(secret) {
  try {
    const bytes = base32Decode(secret);
    if (!bytes.length) return { ok: false, error: 'That secret is empty' };
    return { ok: true, bytes: bytes.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { parseTotpConfig, generateCode, base32Decode, buildOtpAuthUri, validateSecret };
