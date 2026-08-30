'use strict';

/**
 * Real email aliases, from a provider that actually issues them.
 *
 * The generator used to offer an email address it made up: a first name, a
 * random number, and one of twenty real providers' domains. Nothing created
 * that mailbox. The domain belonged to somebody else. It handed you a
 * stranger's address and left you to find out. That was removed.
 *
 * This is the honest version. An alias comes from a provider that issues them,
 * the address exists, mail sent to it reaches you, and you can switch it off
 * later when it starts receiving spam. That is the whole point of an alias and
 * it is not something a password manager can fake.
 *
 * Four providers. SimpleLogin, Firefox Relay and addy.io all publish an API and
 * mean it. DuckDuckGo does not: it has no public API, does not support other
 * applications using this, and the token has to be lifted out of the browser's
 * network inspector. It is here because people asked for it and it works, and it
 * is labelled everywhere it appears, because a feature that can vanish when
 * somebody else changes their mind should not look like the other three.
 *
 * The key is a credential, so it is encrypted with DPAPI the same way stored
 * master passwords are, and it never leaves this process. The renderer asks for
 * an alias and gets an address back; it never sees the key, and neither does
 * anything written to disk in plain text.
 */

const https = require('https');
const { safeStorage } = require('electron');

const settings = require('./settings');

const TIMEOUT_MS = 15000;
const MAX_BODY = 256 * 1024;

/**
 * Each provider differs in ways that fail quietly if guessed: SimpleLogin
 * authenticates with its own header rather than a bearer token, Firefox Relay
 * uses Django's "Token" scheme rather than "Bearer", addy.io rejects anything
 * without X-Requested-With, and DuckDuckGo returns the local part alone and
 * expects the domain to be added. All four were read from what the providers
 * actually document, or in DuckDuckGo's case from what it actually does.
 */
const PROVIDERS = {
  simplelogin: {
    key: 'simplelogin',
    name: 'SimpleLogin',
    host: 'app.simplelogin.io',
    keyUrl: 'https://app.simplelogin.io/dashboard/api_key',
    // SimpleLogin uses its own header rather than Authorization.
    headers: (apiKey) => ({ Authentication: apiKey, 'Content-Type': 'application/json' }),
    verify: { method: 'GET', path: '/api/user_info' },
    describeAccount: (body) => body && body.email,
    create: ({ note, hostname }) => ({
      method: 'POST',
      path: '/api/alias/random/new' + (hostname ? '?hostname=' + encodeURIComponent(hostname) : ''),
      body: { note: note || 'Created by Propolis' }
    }),
    readAlias: (body) => (body && (body.alias || body.email)) || null
  },

  firefox: {
    key: 'firefox',
    name: 'Firefox Relay',
    host: 'relay.firefox.com',
    keyUrl: 'https://relay.firefox.com/accounts/settings/',
    // Django REST framework token auth, which is "Token" and not "Bearer".
    headers: (apiKey) => ({
      Authorization: 'Token ' + apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    }),
    verify: { method: 'GET', path: '/api/v1/profiles/' },
    describeAccount: (body) => {
      const first = Array.isArray(body) ? body[0] : body;
      return (first && (first.email || first.user_email)) || null;
    },
    create: ({ note, hostname }) => ({
      method: 'POST',
      path: '/api/v1/relayaddresses/',
      body: {
        enabled: true,
        description: note || 'Created by Propolis',
        generated_for: hostname || ''
      }
    }),
    readAlias: (body) => (body && (body.full_address || body.address)) || null
  },

  duckduckgo: {
    key: 'duckduckgo',
    name: 'DuckDuckGo',
    host: 'quack.duckduckgo.com',
    keyUrl: 'https://duckduckgo.com/email/settings',
    // DuckDuckGo publishes no API and does not support other applications using
    // this. The token has to be read out of the browser's network inspector
    // while the Email Protection page generates an address. It works, and it can
    // stop working whenever they change something, so the interface says so
    // rather than letting somebody find out when it breaks.
    unofficial: true,
    note:
      'DuckDuckGo does not publish an API or support other apps using it. The ' +
      'token has to be copied out of your browser developer tools, and this can ' +
      'stop working without warning if they change anything.',
    headers: (apiKey) => ({
      Authorization: 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    }),
    // No endpoint exists that checks a token without also using it, and burning
    // a real address to test one would be rude to a free service.
    verify: null,
    describeAccount: () => null,
    create: () => ({ method: 'POST', path: '/api/email/addresses', body: {} }),
    // The reply carries the local part alone, so the domain is added here.
    readAlias: (body) => (body && body.address ? body.address + '@duck.com' : null)
  },

  addy: {
    key: 'addy',
    name: 'addy.io',
    host: 'app.addy.io',
    keyUrl: 'https://app.addy.io/settings/api',
    // addy.io rejects requests without X-Requested-With, which is easy to miss.
    headers: (apiKey) => ({
      Authorization: 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Requested-With': 'XMLHttpRequest'
    }),
    verify: { method: 'GET', path: '/api/v1/api-token-details' },
    describeAccount: (body) => (body && body.data && body.data.name) || null,
    create: ({ note, domain }) => ({
      method: 'POST',
      path: '/api/v1/aliases',
      body: {
        domain: domain || 'anonaddy.me',
        format: 'random_characters',
        description: note || 'Created by Propolis'
      }
    }),
    readAlias: (body) => (body && body.data && body.data.email) || null
  }
};

function providerFor(key) {
  const provider = PROVIDERS[String(key || '').toLowerCase()];
  if (!provider) throw new Error('Unknown alias provider');
  return provider;
}

function choices() {
  return Object.values(PROVIDERS).map((p) => ({
    key: p.key,
    name: p.name,
    keyUrl: p.keyUrl,
    unofficial: Boolean(p.unofficial),
    note: p.note || null
  }));
}

/* ------------------------------------------------------------- key storage */

function storeKey(providerKey, apiKey) {
  const provider = providerFor(providerKey);
  const value = String(apiKey || '').trim();
  if (!value) throw new Error('Paste your API key first');
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Windows credential encryption is not available, so the key cannot be stored safely');
  }
  const sealed = safeStorage.encryptString(value).toString('base64');
  settings.setPrefs({
    aliasProvider: provider.key,
    aliasKeys: { ...(settings.getPrefs().aliasKeys || {}), [provider.key]: sealed }
  });
  return { ok: true };
}

function readKey(providerKey) {
  const provider = providerFor(providerKey);
  const sealed = (settings.getPrefs().aliasKeys || {})[provider.key];
  if (!sealed) return null;
  try {
    return safeStorage.decryptString(Buffer.from(sealed, 'base64'));
  } catch {
    // Sealed under a different Windows account, or the profile was copied.
    return null;
  }
}

function clearKey(providerKey) {
  const provider = providerFor(providerKey);
  // Written as null rather than deleted, because setPrefs deep merges and a
  // key left out of the object would simply keep its old value. Everything
  // reading these treats a falsy entry as absent.
  settings.setPrefs({
    aliasKeys: { ...(settings.getPrefs().aliasKeys || {}), [provider.key]: null }
  });
  return { ok: true };
}

/** What the settings screen needs, without ever handing over a key. */
function status() {
  const prefs = settings.getPrefs();
  const stored = prefs.aliasKeys || {};
  return {
    provider: prefs.aliasProvider || null,
    providers: choices().map((p) => ({ ...p, hasKey: Boolean(stored[p.key]) })),
    allowInventedEmail: prefs.allowInventedEmail === true
  };
}

/* --------------------------------------------------------------- transport */

function requestJson(provider, apiKey, { method, path, body }) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const headers = provider.headers(apiKey);
    if (payload) headers['Content-Length'] = String(payload.length);

    const req = https.request(
      { host: provider.host, path, method, headers, timeout: TIMEOUT_MS },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BODY) {
            req.destroy();
            reject(new Error('The provider sent an unexpectedly large reply'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            /* handled below by status code */
          }
          if (res.statusCode === 401 || res.statusCode === 403) {
            reject(new Error('That API key was refused by ' + provider.name + '.'));
            return;
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const detail =
              (parsed && (parsed.error || parsed.message)) ||
              (text ? text.slice(0, 200) : 'no reply');
            reject(new Error(provider.name + ' said: ' + detail));
            return;
          }
          resolve(parsed);
        });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(provider.name + ' did not answer in time'));
    });
    req.on('error', (err) => {
      reject(new Error('Could not reach ' + provider.name + ': ' + err.message));
    });

    if (payload) req.write(payload);
    req.end();
  });
}

/* ----------------------------------------------------------------- actions */

/** Proves a key works before it is relied on, and says whose account it is. */
async function verify({ provider: providerKey, apiKey } = {}) {
  const provider = providerFor(providerKey);
  const key = apiKey ? String(apiKey).trim() : readKey(provider.key);
  if (!key) throw new Error('No API key has been saved for ' + provider.name + ' yet');

  // Some providers have nothing that checks a token without spending an
  // address. Saying the key is stored is honest; claiming it was verified
  // would not be.
  if (!provider.verify) {
    return { ok: true, provider: provider.key, account: null, unverified: true };
  }

  const body = await requestJson(provider, key, provider.verify);
  return { ok: true, provider: provider.key, account: provider.describeAccount(body) || null };
}

/**
 * Creates one real alias. `hostname` is passed to SimpleLogin so the alias is
 * labelled with the site it was made for, which is what makes them manageable
 * later when you have two hundred of them.
 */
async function create({ provider: providerKey, note, hostname, domain } = {}) {
  const provider = providerFor(providerKey || settings.getPrefs().aliasProvider);
  const key = readKey(provider.key);
  if (!key) {
    throw new Error('Add your ' + provider.name + ' API key in Settings first');
  }
  const body = await requestJson(provider, key, provider.create({ note, hostname, domain }));
  const address = provider.readAlias(body);
  if (!address) throw new Error(provider.name + ' did not return an address');
  return { ok: true, provider: provider.key, address };
}

module.exports = {
  choices,
  status,
  storeKey,
  clearKey,
  verify,
  create,
  PROVIDERS
};
