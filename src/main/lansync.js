'use strict';

/**
 * Syncing between two machines on the same network, with nothing in between.
 *
 * WebDAV and SFTP already work and both mean trusting a server. This is the
 * version where the two devices talk to each other directly: your laptop asks
 * your desktop for its copy, they merge, and nothing ever leaves the building.
 *
 * The network is not assumed to be friendly. Office wifi and a coffee shop are
 * the same thing here, so:
 *
 * Devices are paired once, deliberately, using a code shown on one and typed on
 * the other. The code is mixed into the key agreement, so a machine that does
 * not know it cannot complete the handshake, and it is long enough that
 * guessing it offline from a captured transcript is not worth attempting. Six
 * digits would not have been.
 *
 * After pairing each device remembers the other's public key and the code is
 * never needed again. An unpaired device gets nothing: not the file, not the
 * database name, not a list of what is here.
 *
 * Everything on the wire is encrypted with a key the two of them agree per
 * connection. That is belt and braces rather than the main defence, because a
 * .kdbx is already encrypted with the master password before it is sent. Even a
 * total failure here hands somebody a file they still cannot open.
 *
 * Announcing presence is deliberately not something this does all the time. It
 * broadcasts only while somebody is actually looking, because a laptop that
 * tells every network it joins that it holds a password database is doing the
 * user no favours.
 */

const crypto = require('crypto');
const dgram = require('dgram');
const net = require('net');
const os = require('os');

const settings = require('./settings');

const TCP_PORT = 39587;
const UDP_PORT = 39588;
const PROTOCOL = 1;

/** Long enough that a captured handshake cannot be brute forced offline. */
const PAIR_CODE_LENGTH = 12;
const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1

const MAX_FRAME = 64 * 1024 * 1024; // a .kdbx with attachments can be large
const ANNOUNCE_MS = 1000;
const DISCOVER_MS = 4000;

let server = null;
let announcer = null;
let pendingPair = null;
let fileProvider = null;
let approver = null;

/* ---------------------------------------------------------------- identity */

/**
 * This machine's long lived key pair, kept so a paired device still recognises
 * it tomorrow. The private half is sealed the way every other stored secret is.
 */
function identity() {
  const prefs = settings.getPrefs();
  const stored = prefs.lanIdentity;
  if (stored && stored.publicKey && stored.privateKey) {
    return {
      publicKey: stored.publicKey,
      privateKey: crypto.createPrivateKey({
        key: Buffer.from(stored.privateKey, 'base64'),
        format: 'der',
        type: 'pkcs8'
      })
    };
  }

  const pair = crypto.generateKeyPairSync('x25519');
  const record = {
    publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
  };
  settings.setPrefs({ lanIdentity: record });
  return { publicKey: record.publicKey, privateKey: pair.privateKey };
}

function importPeerKey(base64) {
  return crypto.createPublicKey({
    key: Buffer.from(String(base64 || ''), 'base64'),
    format: 'der',
    type: 'spki'
  });
}

/**
 * A short readable digest of a public key, so two people can check they paired
 * with each other rather than with somebody sitting between them.
 */
function fingerprint(publicKeyBase64) {
  const digest = crypto.createHash('sha256').update(String(publicKeyBase64 || '')).digest('hex');
  return (digest.slice(0, 4) + '-' + digest.slice(4, 8) + '-' + digest.slice(8, 12)).toUpperCase();
}

function deviceName() {
  return String(settings.getPrefs().lanDeviceName || os.hostname() || 'This computer').slice(0, 60);
}

/* ------------------------------------------------------------------- peers */

function peers() {
  const list = settings.getPrefs().lanPeers;
  return Array.isArray(list) ? list.filter(Boolean) : [];
}

function findPeer(publicKey) {
  return peers().find((p) => p && p.publicKey === publicKey) || null;
}

function savePeer(record) {
  const list = peers().filter((p) => p.publicKey !== record.publicKey);
  list.push(record);
  settings.setPrefs({ lanPeers: list });
  return record;
}

function forgetPeer(id) {
  settings.setPrefs({ lanPeers: peers().filter((p) => p.id !== id) });
  return { ok: true };
}

function listPeers() {
  return peers().map((p) => ({
    id: p.id,
    name: p.name,
    fingerprint: fingerprint(p.publicKey),
    lastSeen: p.lastSeen || 0,
    address: p.address || null
  }));
}

/* ----------------------------------------------------------------- pairing */

function makePairCode() {
  let code = '';
  for (let i = 0; i < PAIR_CODE_LENGTH; i++) {
    code += PAIR_ALPHABET[crypto.randomInt(PAIR_ALPHABET.length)];
  }
  return code.match(/.{1,4}/g).join('-');
}

function normaliseCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z2-9]/g, '');
}

/**
 * Opens a window during which this machine will accept one pairing, using this
 * code. It closes on its own, because a pairing code left live indefinitely is
 * a password somebody wrote on the wall.
 */
function beginPairing({ minutes = 5 } = {}) {
  const code = makePairCode();
  if (pendingPair && pendingPair.timer) clearTimeout(pendingPair.timer);
  pendingPair = {
    code: normaliseCode(code),
    expiresAt: Date.now() + minutes * 60 * 1000,
    timer: setTimeout(() => { pendingPair = null; }, minutes * 60 * 1000)
  };
  if (pendingPair.timer.unref) pendingPair.timer.unref();
  return { code, expiresAt: pendingPair.expiresAt, fingerprint: fingerprint(identity().publicKey) };
}

function cancelPairing() {
  if (pendingPair && pendingPair.timer) clearTimeout(pendingPair.timer);
  pendingPair = null;
  return { ok: true };
}

function pairingOpen() {
  return Boolean(pendingPair) && Date.now() < pendingPair.expiresAt;
}

/* -------------------------------------------------------------------- keys */

/**
 * The key for one connection.
 *
 * The pairing code goes into the derivation, so during pairing both sides must
 * know it to arrive at the same key. Afterwards there is no code and the stored
 * public keys are what make the connection meaningful.
 */
function sessionKey(privateKey, peerPublicKey, code) {
  const secret = crypto.diffieHellman({ privateKey, publicKey: peerPublicKey });
  const salt = code ? Buffer.from(normaliseCode(code), 'utf8') : Buffer.alloc(0);
  return Buffer.from(crypto.hkdfSync('sha256', secret, salt, 'propolis-lan-v1', 32));
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
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(String(nonce || ''), 'base64'), {
    authTagLength: 16
  });
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  return JSON.parse(
    Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]).toString('utf8')
  );
}

/* ---------------------------------------------------------------- protocol */

function setFileProvider(fn) {
  fileProvider = fn;
}

function setApprover(fn) {
  approver = fn;
}

/**
 * One message in, one out. Separate from the socket so the protocol can be
 * exercised without opening a port.
 */
async function handleMessage(message, context = {}) {
  if (!message || typeof message !== 'object') throw new Error('Malformed message');
  const me = identity();

  if (message.action === 'hello') {
    // Says who this machine is and whether it would consider pairing. It does
    // not say what databases are here, because an unpaired caller has no
    // business knowing that.
    return {
      action: 'hello',
      protocol: PROTOCOL,
      publicKey: me.publicKey,
      name: deviceName(),
      fingerprint: fingerprint(me.publicKey),
      pairing: pairingOpen(),
      known: Boolean(findPeer(message.publicKey))
    };
  }

  if (message.action === 'pair') {
    if (!pairingOpen()) {
      const err = new Error('This computer is not expecting to pair right now');
      err.code = 'not-pairing';
      throw err;
    }
    const peerKey = importPeerKey(message.publicKey);
    const key = sessionKey(me.privateKey, peerKey, pendingPair.code);

    // Proving they hold the code means decrypting what they sent with a key
    // that only the code produces. A wrong code fails here and nowhere later.
    let proof;
    try {
      proof = open(key, message.nonce, message.box);
    } catch {
      const err = new Error('That pairing code is not the one shown here');
      err.code = 'bad-code';
      throw err;
    }
    if (proof.action !== 'pair-proof') throw new Error('Unexpected pairing message');

    if (typeof approver === 'function') {
      const ok = await approver({
        name: proof.name || 'Another computer',
        fingerprint: fingerprint(message.publicKey),
        address: context.address || null
      });
      if (!ok) {
        const err = new Error('You declined the pairing');
        err.code = 'declined';
        throw err;
      }
    }

    savePeer({
      id: crypto.randomUUID(),
      name: String(proof.name || 'Another computer').slice(0, 60),
      publicKey: message.publicKey,
      address: context.address || null,
      lastSeen: Date.now()
    });
    cancelPairing();

    return { action: 'pair', ...seal(key, { paired: true, name: deviceName() }) };
  }

  if (message.action === 'message') {
    const peer = findPeer(message.publicKey);
    if (!peer) {
      const err = new Error('This computer has not been paired with yours');
      err.code = 'not-paired';
      throw err;
    }
    const key = sessionKey(me.privateKey, importPeerKey(message.publicKey), null);
    let inner;
    try {
      inner = open(key, message.nonce, message.box);
    } catch {
      const err = new Error('That message could not be read');
      err.code = 'bad-key';
      throw err;
    }
    savePeer({ ...peer, address: context.address || peer.address, lastSeen: Date.now() });
    return { action: 'message', ...seal(key, await handleInner(inner, peer)) };
  }

  throw new Error('Unknown action: ' + String(message.action));
}

async function handleInner(inner, peer) {
  if (typeof fileProvider !== 'function') throw new Error('Nothing is set up to share here');

  switch (inner.action) {
    case 'describe':
      return fileProvider({ action: 'describe', peer });
    case 'pull':
      return fileProvider({ action: 'pull', peer, name: inner.name });
    case 'push':
      return fileProvider({ action: 'push', peer, name: inner.name, data: inner.data });
    default:
      throw new Error('Unknown request: ' + String(inner.action));
  }
}

/* ------------------------------------------------------------------ frames */

function writeFrame(socket, object) {
  const body = Buffer.from(JSON.stringify(object), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  socket.write(Buffer.concat([head, body]));
}

function readFrames(socket, onMessage) {
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
      try {
        await onMessage(JSON.parse(body.toString('utf8')));
      } catch (err) {
        try {
          writeFrame(socket, { error: err.message, code: err.code || null });
        } catch {
          /* the socket went away, which is not our problem to solve */
        }
      }
    }
  });
  socket.on('error', () => socket.destroy());
}

/* ------------------------------------------------------------------ server */

function start() {
  if (server) return status();
  server = net.createServer((socket) => {
    const address = socket.remoteAddress || null;
    readFrames(socket, async (message) => {
      writeFrame(socket, await handleMessage(message, { address }));
    });
  });
  server.on('error', (err) => {
    console.error('lan sync: ' + err.message);
    server = null;
  });
  server.listen(TCP_PORT);
  return status();
}

function stop() {
  if (server) {
    server.close();
    server = null;
  }
  stopAnnouncing();
  return status();
}

function status() {
  return {
    running: Boolean(server),
    port: TCP_PORT,
    name: deviceName(),
    fingerprint: fingerprint(identity().publicKey),
    pairing: pairingOpen(),
    peers: listPeers(),
    addresses: localAddresses()
  };
}

function localAddresses() {
  const out = [];
  for (const entries of Object.values(os.networkInterfaces() || {})) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) out.push(entry.address);
    }
  }
  return out;
}

/* --------------------------------------------------------------- discovery */

/**
 * Says "a Propolis is here" on the local network, for as long as somebody is
 * looking at the pairing screen and no longer. Carries a name and a fingerprint
 * and nothing else: no database names, no file list.
 */
function startAnnouncing() {
  if (announcer) return;
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  socket.bind(() => {
    socket.setBroadcast(true);
    const beat = () => {
      const me = identity();
      const payload = Buffer.from(
        JSON.stringify({
          propolis: PROTOCOL,
          name: deviceName(),
          fingerprint: fingerprint(me.publicKey),
          port: TCP_PORT
        }),
        'utf8'
      );
      socket.send(payload, 0, payload.length, UDP_PORT, '255.255.255.255', () => {});
    };
    beat();
    announcer = { socket, timer: setInterval(beat, ANNOUNCE_MS) };
    if (announcer.timer.unref) announcer.timer.unref();
  });
}

function stopAnnouncing() {
  if (!announcer) return;
  clearInterval(announcer.timer);
  try {
    announcer.socket.close();
  } catch {
    /* already closed */
  }
  announcer = null;
}

/** Listens for a few seconds and reports what answered. */
function discover({ ms = DISCOVER_MS } = {}) {
  return new Promise((resolve) => {
    const found = new Map();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    socket.on('message', (data, from) => {
      try {
        const announced = JSON.parse(data.toString('utf8'));
        if (!announced || announced.propolis !== PROTOCOL) return;
        if (announced.fingerprint === fingerprint(identity().publicKey)) return; // ourselves
        found.set(announced.fingerprint, {
          name: String(announced.name || 'A computer').slice(0, 60),
          fingerprint: announced.fingerprint,
          address: from.address,
          port: Number(announced.port) || TCP_PORT,
          paired: peers().some((p) => fingerprint(p.publicKey) === announced.fingerprint)
        });
      } catch {
        /* something else is using this port */
      }
    });

    socket.on('error', () => resolve([]));
    socket.bind(UDP_PORT, () => {
      setTimeout(() => {
        try {
          socket.close();
        } catch {
          /* already gone */
        }
        resolve(Array.from(found.values()));
      }, ms).unref?.();
    });
  });
}

module.exports = {
  start,
  stop,
  status,
  identity,
  fingerprint,
  handleMessage,
  beginPairing,
  cancelPairing,
  pairingOpen,
  listPeers,
  forgetPeer,
  savePeer,
  findPeer,
  setFileProvider,
  setApprover,
  sessionKey,
  seal,
  open,
  importPeerKey,
  normaliseCode,
  makePairCode,
  startAnnouncing,
  stopAnnouncing,
  discover,
  localAddresses,
  TCP_PORT,
  UDP_PORT,
  PROTOCOL
};
