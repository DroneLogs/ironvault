'use strict';

/**
 * The desktop half of the browser extension.
 *
 * A browser extension cannot talk to a desktop application directly. It speaks
 * native messaging, which means the browser launches a small helper process and
 * exchanges length prefixed JSON with it over stdio. That helper has no vault of
 * its own, so it forwards to this, over the same kind of Windows named pipe the
 * SSH agent already uses.
 *
 *   extension  <-- stdio -->  propolis-browser-host  <-- pipe -->  Propolis
 *
 * The security problem this creates is the whole design. A named pipe on the
 * local machine can be opened by anything running as the same user, so a pipe
 * that hands out passwords to whoever asks would be worse than having no
 * extension at all. Three things prevent that.
 *
 * Every extension has its own key pair, and the application will not talk to one
 * it has not been introduced to. Being introduced requires the user to approve
 * it in a dialog in the app itself, so a program that opens the pipe on its own
 * cannot associate silently; it can only ask, and the user sees who is asking.
 *
 * Every message after the handshake is encrypted to that specific extension.
 * Another process on the pipe cannot read a reply meant for the browser, and
 * cannot forge a request, because it does not hold the key.
 *
 * And credentials are only ever returned for a site the entry actually belongs
 * to, matched on host rather than on substring, so a page at
 * github.com.evil.example cannot ask for the GitHub entry.
 *
 * Crypto is X25519 for agreement and AES-256-GCM for the messages, both from
 * Node's own crypto module, so there is no dependency to carry or audit.
 *
 * AES rather than ChaCha20-Poly1305, which was the first choice: Electron links
 * BoringSSL rather than OpenSSL and exposes 28 ciphers, none of them ChaCha.
 * Checked under Electron rather than assumed from Node, where it is present and
 * would have looked fine right up until the first message failed.
 *
 * Nonces are random and 96 bits. The key is derived per extension per run of
 * the app, and the traffic is a handful of messages per page, so the birthday
 * bound on random GCM nonces is nowhere near reachable.
 */

const crypto = require('crypto');
const net = require('net');

const settings = require('./settings');
const vault = require('./vault');

const PIPE_NAME = '\\\\.\\pipe\\propolis-browser';
const PROTOCOL = 1;

/** Anything longer than this is not a request we make, so it is not read. */
const MAX_FRAME = 1024 * 1024;

let server = null;
let approver = null;
let sessionKeys = null;

/** Asks the app to put an approval dialog in front of the user. */
function setApprover(fn) {
  approver = fn;
}

/* ------------------------------------------------------------------- keys */

/** One key pair per run. Associations survive; this does not need to. */
function keys() {
  if (!sessionKeys) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
    sessionKeys = { publicKey, privateKey };
  }
  return sessionKeys;
}

function publicKeyBase64() {
  return keys().publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
}

function importPeerKey(base64) {
  return crypto.createPublicKey({
    key: Buffer.from(String(base64 || ''), 'base64'),
    format: 'der',
    type: 'spki'
  });
}

/**
 * The shared secret is per pair of keys, so it is run through HKDF with a fixed
 * label rather than used raw. Two extensions never share a key, and the same
 * extension gets a different one after a restart.
 */
function sharedKey(peerPublicKey) {
  const secret = crypto.diffieHellman({ privateKey: keys().privateKey, publicKey: peerPublicKey });
  return Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.alloc(0), 'propolis-browser-v1', 32));
}

function seal(key, payload) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return { nonce: nonce.toString('base64'), box: Buffer.concat([body, cipher.getAuthTag()]).toString('base64') };
}

function open(key, nonce, box) {
  const raw = Buffer.from(String(box || ''), 'base64');
  if (raw.length < 17) throw new Error('Malformed message');
  const tag = raw.subarray(raw.length - 16);
  const body = raw.subarray(0, raw.length - 16);
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(String(nonce || ''), 'base64'),
    { authTagLength: 16 }
  );
  decipher.setAuthTag(tag);
  const text = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  return JSON.parse(text);
}

/* ----------------------------------------------------------- associations */

function associations() {
  const list = settings.getPrefs().browserAssociations;
  return Array.isArray(list) ? list.filter(Boolean) : [];
}

function findAssociation(publicKey) {
  return associations().find((a) => a && a.publicKey === publicKey) || null;
}

function saveAssociation(record) {
  const list = associations().filter((a) => a.publicKey !== record.publicKey);
  list.push(record);
  settings.setPrefs({ browserAssociations: list });
  return record;
}

function forget(id) {
  settings.setPrefs({ browserAssociations: associations().filter((a) => a.id !== id) });
  return { ok: true };
}

function listConnections() {
  return associations().map((a) => ({ id: a.id, name: a.name, createdAt: a.createdAt }));
}

/* -------------------------------------------------------------- url match */

/**
 * Whether an entry's stored URL covers the page asking.
 *
 * Compared by host, and by whole labels, so example.com covers
 * login.example.com but never covers example.com.evil.test. Substring matching
 * is what makes this class of feature dangerous, so it is not used anywhere.
 */
function hostOf(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : 'https://' + text);
    return url.hostname.toLowerCase().replace(/\.$/, '') || null;
  } catch {
    return null;
  }
}

function hostMatches(entryUrl, pageHost) {
  const entryHost = hostOf(entryUrl);
  if (!entryHost || !pageHost) return false;
  if (entryHost === pageHost) return true;
  return pageHost.endsWith('.' + entryHost);
}

/* ------------------------------------------------------------------ calls */

function requireUnlocked() {
  if (!vault.isOpen()) {
    const err = new Error('Propolis is locked. Unlock it to fill passwords.');
    err.code = 'locked';
    throw err;
  }
}

function statusPayload() {
  const open = vault.isOpen();
  return {
    unlocked: open,
    database: open ? (vault.info() || {}).name || null : null,
    version: PROTOCOL
  };
}

/** Entries whose URL covers the page, with their secrets, for one request. */
function loginsFor(url) {
  requireUnlocked();
  const host = hostOf(url);
  if (!host) throw new Error('That does not look like a web address');

  // listEntries, not search: an empty query to search returns nothing by
  // design, and every entry has to be considered to match on host.
  const results = [];
  for (const entry of vault.listEntries({ scope: 'all' }) || []) {
    if (!hostMatches(entry.url, host)) continue;
    let password = '';
    try {
      password = vault.getSecret(entry.id, 'Password') || '';
    } catch {
      continue;
    }
    results.push({
      uuid: entry.id,
      title: entry.title || '',
      username: entry.username || '',
      password,
      url: entry.url || ''
    });
  }
  return { logins: results, host };
}

function totpFor(uuid) {
  requireUnlocked();
  const code = vault.getTotp(uuid);
  if (!code || code.error) throw new Error(code ? code.error : 'That entry has no one time code');
  return { code: code.code, seconds: code.seconds };
}

/* --------------------------------------------------------------- dispatch */

async function handleAssociate(message, peerKey) {
  const name = String(message.name || 'A browser extension').slice(0, 80);
  const existing = findAssociation(message.publicKey);
  if (existing) return { associated: true, id: existing.id, name: existing.name };

  if (typeof approver !== 'function') {
    throw new Error('Propolis cannot ask for approval right now');
  }
  const approved = await approver({ name });
  if (!approved) {
    const err = new Error('You declined the connection');
    err.code = 'declined';
    throw err;
  }
  const record = saveAssociation({
    id: crypto.randomUUID(),
    name,
    publicKey: message.publicKey,
    createdAt: Date.now()
  });
  return { associated: true, id: record.id, name: record.name };
}

async function handleInner(inner) {
  switch (inner.action) {
    case 'get-status':
      return statusPayload();
    case 'get-logins':
      return loginsFor(inner.url);
    case 'get-totp':
      return totpFor(inner.uuid);
    default:
      throw new Error('Unknown request: ' + String(inner.action));
  }
}

/**
 * One message in, one message out. Split from the socket handling so the
 * protocol can be tested without a pipe.
 */
async function handleMessage(message) {
  if (!message || typeof message !== 'object') throw new Error('Malformed message');

  if (message.action === 'hello') {
    return {
      action: 'hello',
      publicKey: publicKeyBase64(),
      protocol: PROTOCOL,
      associated: Boolean(findAssociation(message.publicKey))
    };
  }

  if (message.action === 'associate') {
    const peerKey = importPeerKey(message.publicKey);
    const result = await handleAssociate(message, peerKey);
    return { action: 'associate', ...result };
  }

  if (message.action === 'message') {
    const association = findAssociation(message.publicKey);
    if (!association) {
      const err = new Error('This browser is not connected to Propolis yet');
      err.code = 'not-associated';
      throw err;
    }
    const key = sharedKey(importPeerKey(message.publicKey));
    let inner;
    try {
      inner = open(key, message.nonce, message.box);
    } catch {
      // A bad tag means the sender does not hold the key. Nothing more is said
      // about it, since the difference between wrong key and corrupt message is
      // not the caller's business.
      const err = new Error('That message could not be read');
      err.code = 'bad-key';
      throw err;
    }
    const reply = await handleInner(inner);
    return { action: 'message', ...seal(key, reply) };
  }

  throw new Error('Unknown action: ' + String(message.action));
}

/* ----------------------------------------------------------------- server */

function frameOut(socket, object) {
  const body = Buffer.from(JSON.stringify(object), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  socket.write(Buffer.concat([head, body]));
}

function onConnection(socket) {
  let buffer = Buffer.alloc(0);
  socket.on('data', async (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 4) return;
      const length = buffer.readUInt32LE(0);
      if (length > MAX_FRAME) {
        socket.destroy();
        return;
      }
      if (buffer.length < 4 + length) return;
      const body = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);
      let message = null;
      try {
        message = JSON.parse(body.toString('utf8'));
      } catch {
        frameOut(socket, { error: 'Malformed message' });
        continue;
      }
      try {
        frameOut(socket, await handleMessage(message));
      } catch (err) {
        frameOut(socket, { error: err.message, code: err.code || null });
      }
    }
  });
  socket.on('error', () => socket.destroy());
}

function start() {
  if (server) return status();
  server = net.createServer(onConnection);
  server.on('error', (err) => {
    console.error('browser bridge: ' + err.message);
    server = null;
  });
  server.listen(PIPE_NAME);
  return status();
}

function stop() {
  if (server) {
    server.close();
    server = null;
  }
  return { running: false };
}

function status() {
  return {
    running: Boolean(server),
    pipe: PIPE_NAME,
    connections: listConnections()
  };
}

module.exports = {
  start,
  stop,
  status,
  setApprover,
  handleMessage,
  listConnections,
  forget,
  hostMatches,
  hostOf,
  PIPE_NAME,
  PROTOCOL
};
