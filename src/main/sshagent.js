'use strict';

const net = require('net');
const crypto = require('crypto');

/**
 * An SSH agent backed by keys kept in the database.
 *
 * Ironvault listens on its own Windows named pipe and speaks the OpenSSH agent
 * protocol, so `ssh` can borrow a key without it ever being written to disk.
 * Point a shell at it with:
 *
 *   $env:SSH_AUTH_SOCK = '\\.\pipe\ironvault-ssh-agent'
 *
 * The built-in Windows agent keeps its own pipe, so the two do not collide.
 */

const PIPE_NAME = '\\\\.\\pipe\\ironvault-ssh-agent';

const SSH_AGENT_FAILURE = 5;
const SSH_AGENTC_REQUEST_IDENTITIES = 11;
const SSH_AGENT_IDENTITIES_ANSWER = 12;
const SSH_AGENTC_SIGN_REQUEST = 13;
const SSH_AGENT_SIGN_RESPONSE = 14;

const SSH_AGENT_RSA_SHA2_256 = 0x02;
const SSH_AGENT_RSA_SHA2_512 = 0x04;

const MAX_MESSAGE = 256 * 1024;

/* --------------------------------------------------------------- wire format */

function str(buffer) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(buffer.length, 0);
  return Buffer.concat([length, buffer]);
}

/** SSH mpints are signed, so a leading high bit needs a zero byte in front. */
function mpint(buffer) {
  let start = 0;
  while (start < buffer.length - 1 && buffer[start] === 0) start++;
  let body = buffer.subarray(start);
  if (body[0] & 0x80) body = Buffer.concat([Buffer.from([0]), body]);
  return str(body);
}

class Reader {
  constructor(buffer) {
    this.buffer = buffer;
    this.offset = 0;
  }
  uint32() {
    const value = this.buffer.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }
  string() {
    const length = this.uint32();
    const value = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
  get done() {
    return this.offset >= this.buffer.length;
  }
}

/* ------------------------------------------------------------- key handling */

function base64ToBuffer(value) {
  return Buffer.from(String(value).replace(/\s+/g, ''), 'base64');
}

/** Builds the SSH public key blob for a Node private key object. */
function publicBlobFor(keyObject) {
  const jwk = keyObject.export({ format: 'jwk' });

  if (jwk.kty === 'OKP' && jwk.crv === 'Ed25519') {
    return {
      algorithm: 'ssh-ed25519',
      blob: Buffer.concat([str(Buffer.from('ssh-ed25519')), str(base64ToBuffer(jwk.x.replace(/-/g, '+').replace(/_/g, '/')))])
    };
  }

  if (jwk.kty === 'RSA') {
    const e = base64ToBuffer(jwk.e.replace(/-/g, '+').replace(/_/g, '/'));
    const n = base64ToBuffer(jwk.n.replace(/-/g, '+').replace(/_/g, '/'));
    return { algorithm: 'ssh-rsa', blob: Buffer.concat([str(Buffer.from('ssh-rsa')), mpint(e), mpint(n)]) };
  }

  if (jwk.kty === 'EC') {
    const curves = { 'P-256': 'nistp256', 'P-384': 'nistp384', 'P-521': 'nistp521' };
    const curve = curves[jwk.crv];
    if (!curve) return null;
    const x = base64ToBuffer(jwk.x.replace(/-/g, '+').replace(/_/g, '/'));
    const y = base64ToBuffer(jwk.y.replace(/-/g, '+').replace(/_/g, '/'));
    const point = Buffer.concat([Buffer.from([0x04]), x, y]);
    const algorithm = 'ecdsa-sha2-' + curve;
    return {
      algorithm,
      blob: Buffer.concat([str(Buffer.from(algorithm)), str(Buffer.from(curve)), str(point)])
    };
  }

  return null;
}

/** DER encoded ECDSA signatures have to be re-encoded as two SSH mpints. */
function derToSshEcdsa(der) {
  let offset = 0;
  if (der[offset++] !== 0x30) throw new Error('Bad ECDSA signature');
  if (der[offset] & 0x80) offset += 1 + (der[offset] & 0x7f);
  else offset += 1;
  const readInt = () => {
    if (der[offset++] !== 0x02) throw new Error('Bad ECDSA signature');
    const length = der[offset++];
    const value = der.subarray(offset, offset + length);
    offset += length;
    return value;
  };
  const r = readInt();
  const s = readInt();
  return Buffer.concat([mpint(r), mpint(s)]);
}

function looksLikePrivateKey(text) {
  return /-----BEGIN (OPENSSH|RSA|EC|DSA|ENCRYPTED)?\s?PRIVATE KEY-----/.test(text);
}

/**
 * Loads a PEM private key, trying the entry's password as a passphrase when the
 * key turns out to be encrypted.
 */
function loadKey(pem, passphrase) {
  try {
    return crypto.createPrivateKey({ key: pem, format: 'pem' });
  } catch (err) {
    if (passphrase) {
      try {
        return crypto.createPrivateKey({ key: pem, format: 'pem', passphrase });
      } catch {
        /* fall through to the original error */
      }
    }
    throw err;
  }
}

/* ------------------------------------------------------------------- agent */

let server = null;
let keySource = () => [];
let onEvent = () => {};
const loaded = new Map(); // fingerprint -> { keyObject, algorithm, blob, comment }

function fingerprint(blob) {
  return 'SHA256:' + crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
}

/**
 * Rebuilds the key list from the database. Called whenever a request arrives so
 * an entry added while the agent is running is picked up without a restart.
 */
function refreshKeys() {
  loaded.clear();
  const problems = [];

  for (const candidate of keySource()) {
    if (!candidate || !candidate.pem || !looksLikePrivateKey(candidate.pem)) continue;
    try {
      const keyObject = loadKey(candidate.pem, candidate.passphrase);
      const pub = publicBlobFor(keyObject);
      if (!pub) {
        problems.push((candidate.comment || 'key') + ': unsupported key type');
        continue;
      }
      loaded.set(fingerprint(pub.blob), {
        keyObject,
        algorithm: pub.algorithm,
        blob: pub.blob,
        comment: candidate.comment || 'ironvault'
      });
    } catch (err) {
      problems.push((candidate.comment || 'key') + ': ' + err.message);
    }
  }

  return { count: loaded.size, problems };
}

function identitiesAnswer() {
  const parts = [Buffer.from([SSH_AGENT_IDENTITIES_ANSWER])];
  const count = Buffer.alloc(4);
  count.writeUInt32BE(loaded.size, 0);
  parts.push(count);
  for (const key of loaded.values()) {
    parts.push(str(key.blob), str(Buffer.from(key.comment)));
  }
  return Buffer.concat(parts);
}

function signAnswer(reader) {
  const keyBlob = reader.string();
  const data = reader.string();
  const flags = reader.done ? 0 : reader.uint32();

  const key = loaded.get(fingerprint(keyBlob));
  if (!key) return Buffer.from([SSH_AGENT_FAILURE]);

  let algorithm = key.algorithm;
  let signature;

  if (key.algorithm === 'ssh-ed25519') {
    signature = crypto.sign(null, data, key.keyObject);
  } else if (key.algorithm === 'ssh-rsa') {
    let hash = 'sha1';
    if (flags & SSH_AGENT_RSA_SHA2_512) {
      hash = 'sha512';
      algorithm = 'rsa-sha2-512';
    } else if (flags & SSH_AGENT_RSA_SHA2_256) {
      hash = 'sha256';
      algorithm = 'rsa-sha2-256';
    }
    signature = crypto.sign(hash, data, key.keyObject);
  } else if (key.algorithm.startsWith('ecdsa-sha2-')) {
    const hash = { nistp256: 'sha256', nistp384: 'sha384', nistp521: 'sha512' }[key.algorithm.split('-').pop()];
    signature = derToSshEcdsa(crypto.sign(hash, data, key.keyObject));
  } else {
    return Buffer.from([SSH_AGENT_FAILURE]);
  }

  onEvent({ type: 'signed', comment: key.comment, algorithm });
  const body = Buffer.concat([str(Buffer.from(algorithm)), str(signature)]);
  return Buffer.concat([Buffer.from([SSH_AGENT_SIGN_RESPONSE]), str(body)]);
}

function handle(payload) {
  const type = payload[0];
  const reader = new Reader(payload.subarray(1));

  if (type === SSH_AGENTC_REQUEST_IDENTITIES) {
    refreshKeys();
    return identitiesAnswer();
  }
  if (type === SSH_AGENTC_SIGN_REQUEST) {
    refreshKeys();
    try {
      return signAnswer(reader);
    } catch (err) {
      onEvent({ type: 'error', message: err.message });
      return Buffer.from([SSH_AGENT_FAILURE]);
    }
  }
  return Buffer.from([SSH_AGENT_FAILURE]);
}

function onConnection(socket) {
  let buffered = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 4) {
      const length = buffered.readUInt32BE(0);
      if (length > MAX_MESSAGE) {
        socket.destroy();
        return;
      }
      if (buffered.length < 4 + length) return;
      const payload = buffered.subarray(4, 4 + length);
      buffered = buffered.subarray(4 + length);
      if (!payload.length) continue;
      try {
        socket.write(str(handle(payload)));
      } catch {
        socket.write(str(Buffer.from([SSH_AGENT_FAILURE])));
      }
    }
  });

  socket.on('error', () => socket.destroy());
}

function start({ getKeys, notify } = {}) {
  if (process.platform !== 'win32') throw new Error('The SSH agent is Windows only in this build');
  if (server) return status();

  keySource = getKeys || (() => []);
  onEvent = notify || (() => {});

  server = net.createServer(onConnection);
  server.on('error', (err) => {
    onEvent({ type: 'error', message: err.message });
    server = null;
  });
  server.listen(PIPE_NAME);

  const summary = refreshKeys();
  onEvent({ type: 'started', keys: summary.count });
  return { running: true, pipe: PIPE_NAME, ...summary };
}

function stop() {
  if (server) {
    try {
      server.close();
    } catch {
      /* already closing */
    }
    server = null;
  }
  loaded.clear();
  keySource = () => [];
  onEvent({ type: 'stopped' });
  return { running: false };
}

function status() {
  return {
    running: Boolean(server),
    pipe: PIPE_NAME,
    keys: [...loaded.values()].map((key) => ({
      comment: key.comment,
      algorithm: key.algorithm,
      fingerprint: fingerprint(key.blob)
    }))
  };
}

/** Rebuilds the list without waiting for a client request. */
function reload() {
  const summary = refreshKeys();
  return { ...status(), ...summary };
}

module.exports = { start, stop, status, reload, looksLikePrivateKey, publicBlobFor, PIPE_NAME };
