'use strict';

/**
 * Being a passkey authenticator.
 *
 * A passkey is a WebAuthn credential: a key pair where the site keeps the public
 * half and something you own keeps the private half. Signing in means the site
 * sends a challenge and the authenticator signs it. There is nothing to phish,
 * because the signature is bound to the site that asked for it.
 *
 * A desktop application cannot do this by itself. Browsers hand WebAuthn to the
 * platform or to a USB device, and will not hand it to an app. The way in is a
 * browser extension that replaces navigator.credentials on the page and passes
 * the request out, which is why the extension had to exist before this could.
 *
 * This file is the part that does the cryptography and speaks the binary
 * formats. Two operations:
 *
 *   create   a new key pair for a site, returning the public half and an
 *            attestation object the browser can hand back
 *   assert   sign a challenge with a key pair we already hold
 *
 * Credentials are stored as KeePassXC's KPEX_PASSKEY_* fields, so a passkey made
 * here works in KeePassXC and the other way round. Inventing a private format
 * would have been less work and would have trapped people in this app.
 *
 * ES256 only, meaning ECDSA on P-256. It is the one algorithm every relying
 * party accepts, it is required by the specification, and Node implements it, so
 * a second choice would add surface without adding reach.
 */

const crypto = require('crypto');

const vault = require('./vault');

const FIELDS = {
  username: 'KPEX_PASSKEY_USERNAME',
  credentialId: 'KPEX_PASSKEY_CREDENTIAL_ID',
  privateKey: 'KPEX_PASSKEY_PRIVATE_KEY_PEM',
  relyingParty: 'KPEX_PASSKEY_RELYING_PARTY',
  userHandle: 'KPEX_PASSKEY_USER_HANDLE'
};

/** COSE algorithm number for ECDSA with SHA-256. */
const ES256 = -7;

/**
 * Zero, which is what a software authenticator is supposed to report when it
 * has no hardware identity to disclose. Claiming a real one would be a lie a
 * relying party might act on.
 */
const AAGUID = Buffer.alloc(16);

/* ------------------------------------------------------------------ base64 */

function b64url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(text) {
  const padded = String(text || '').replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded + '='.repeat((4 - (padded.length % 4)) % 4), 'base64');
}

/* -------------------------------------------------------------------- CBOR */

/**
 * Just enough CBOR to write an attestation object and a COSE key.
 *
 * Only the types those two need: unsigned and negative integers, byte strings,
 * text strings and maps. A general encoder would be more code and more to get
 * wrong, and nothing here ever encodes anything else.
 */
function cborHead(major, value) {
  if (value < 24) return Buffer.from([(major << 5) | value]);
  if (value < 0x100) return Buffer.from([(major << 5) | 24, value]);
  if (value < 0x10000) {
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(value, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(value, 1);
  return b;
}

function cbor(value) {
  if (Buffer.isBuffer(value)) return Buffer.concat([cborHead(2, value.length), value]);
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([cborHead(3, bytes.length), bytes]);
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new Error('Only integers are encodable here');
    return value < 0 ? cborHead(1, -value - 1) : cborHead(0, value);
  }
  if (value instanceof Map) {
    const parts = [cborHead(5, value.size)];
    for (const [k, v] of value) parts.push(cbor(k), cbor(v));
    return Buffer.concat(parts);
  }
  throw new Error('Cannot encode ' + typeof value + ' as CBOR');
}

/* ------------------------------------------------------------- COSE key */

/**
 * The public key in the shape WebAuthn wants: a CBOR map keyed by small
 * integers rather than names. 1 is the key type, 3 the algorithm, then the
 * curve and the two coordinates on negative keys.
 */
function coseKey(publicKey) {
  const jwk = publicKey.export({ format: 'jwk' });
  const x = fromB64url(jwk.x);
  const y = fromB64url(jwk.y);
  const map = new Map([
    [1, 2],      // kty: EC2
    [3, ES256],  // alg
    [-1, 1],     // crv: P-256
    [-2, x],
    [-3, y]
  ]);
  return cbor(map);
}

/* --------------------------------------------------------- authenticator data */

/**
 * The bytes a relying party checks before it looks at the signature.
 *
 * A hash of the site's id, so a signature made for one site cannot be replayed
 * at another; flags saying what the authenticator did; and a counter. For a
 * registration it also carries the new key itself.
 *
 * The user present and user verified flags are both set, and both are true: the
 * user approved this in Propolis, with the database unlocked, which is a
 * stronger check than the tap on a security key that normally sets them.
 */
function authenticatorData({ rpId, includeCredential, credentialId, publicKey, signCount = 0 }) {
  const rpIdHash = crypto.createHash('sha256').update(rpId, 'utf8').digest();
  const UP = 0x01;
  const UV = 0x04;
  const AT = 0x40;
  const flags = UP | UV | (includeCredential ? AT : 0);

  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(signCount >>> 0, 0);

  if (!includeCredential) {
    return Buffer.concat([rpIdHash, Buffer.from([flags]), counter]);
  }

  const idLength = Buffer.alloc(2);
  idLength.writeUInt16BE(credentialId.length, 0);
  return Buffer.concat([
    rpIdHash,
    Buffer.from([flags]),
    counter,
    AAGUID,
    idLength,
    credentialId,
    coseKey(publicKey)
  ]);
}

function clientDataJSON({ type, challenge, origin }) {
  // Field order is not required to match anything, since the relying party is
  // given these exact bytes and hashes them as they arrive.
  return Buffer.from(
    JSON.stringify({ type, challenge, origin, crossOrigin: false }),
    'utf8'
  );
}

/* ------------------------------------------------------------------ create */

/**
 * Makes a new passkey for a site.
 *
 * The private half never leaves this process: it goes straight into the
 * database as a protected field, and what the page receives is the public half
 * and an identifier.
 *
 * Attestation is "none", which is the honest answer. Attestation exists to let
 * a relying party recognise a particular make of hardware, and this is
 * software. Claiming otherwise would mean forging a certificate chain.
 */
function create({ origin, rpId, rpName, userName, userDisplayName, userHandle, challenge } = {}) {
  const host = hostOf(origin);
  if (!host) throw new Error('That request did not come from a web page');
  const effectiveRpId = rpId || host;
  if (!coversHost(effectiveRpId, host)) {
    throw new Error('A site cannot make a passkey for a different domain');
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const credentialId = crypto.randomBytes(32);
  const handle = userHandle ? fromB64url(userHandle) : crypto.randomBytes(32);

  const clientData = clientDataJSON({ type: 'webauthn.create', challenge, origin });
  const authData = authenticatorData({
    rpId: effectiveRpId,
    includeCredential: true,
    credentialId,
    publicKey
  });

  const attestationObject = cbor(
    new Map([
      ['fmt', 'none'],
      ['attStmt', new Map()],
      ['authData', authData]
    ])
  );

  return {
    credential: {
      id: b64url(credentialId),
      rawId: b64url(credentialId),
      type: 'public-key',
      response: {
        clientDataJSON: b64url(clientData),
        attestationObject: b64url(attestationObject),
        transports: ['internal']
      }
    },
    store: {
      relyingParty: effectiveRpId,
      relyingPartyName: rpName || effectiveRpId,
      userName: userName || '',
      userDisplayName: userDisplayName || userName || '',
      userHandle: b64url(handle),
      credentialId: b64url(credentialId),
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    }
  };
}

/* ------------------------------------------------------------------ assert */

/** Signs a challenge with a key we already hold. */
function assertion({ origin, rpId, challenge, stored, signCount = 0 } = {}) {
  const host = hostOf(origin);
  if (!host) throw new Error('That request did not come from a web page');
  const effectiveRpId = rpId || host;
  if (!coversHost(effectiveRpId, host)) {
    throw new Error('A site cannot use a passkey belonging to a different domain');
  }
  if (stored.relyingParty && stored.relyingParty !== effectiveRpId) {
    throw new Error('That passkey belongs to ' + stored.relyingParty);
  }

  const privateKey = crypto.createPrivateKey(stored.privateKeyPem);
  const clientData = clientDataJSON({ type: 'webauthn.get', challenge, origin });
  const authData = authenticatorData({ rpId: effectiveRpId, includeCredential: false, signCount });

  // What gets signed is the authenticator data followed by a hash of the client
  // data, which is what binds the signature to this site and this challenge.
  const signed = Buffer.concat([authData, crypto.createHash('sha256').update(clientData).digest()]);
  const signature = crypto.sign('sha256', signed, privateKey);

  const credentialId = fromB64url(stored.credentialId);
  return {
    id: b64url(credentialId),
    rawId: b64url(credentialId),
    type: 'public-key',
    response: {
      clientDataJSON: b64url(clientData),
      authenticatorData: b64url(authData),
      signature: b64url(signature),
      userHandle: stored.userHandle || null
    }
  };
}

/* ------------------------------------------------------------------- hosts */

function hostOf(value) {
  try {
    return new URL(String(value || '')).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * Whether a relying party id may speak for a host. Same whole label rule the
 * bridge uses: example.com covers login.example.com and never covers
 * example.com.evil.test.
 */
function coversHost(rpId, host) {
  const id = String(rpId || '').toLowerCase();
  if (!id || !host) return false;
  return host === id || host.endsWith('.' + id);
}

/* ------------------------------------------------------------------ vault */

function readStored(entry) {
  const fields = (entry && entry.customFields) || [];
  const get = (key) => {
    const found = fields.find((f) => f.key.toUpperCase() === key);
    return found ? found.value : '';
  };
  const credentialId = get(FIELDS.credentialId);
  if (!credentialId) return null;
  return {
    entryId: entry.id,
    title: entry.title || '',
    relyingParty: get(FIELDS.relyingParty),
    userName: get(FIELDS.username),
    userHandle: get(FIELDS.userHandle),
    credentialId
  };
}

/**
 * Every passkey in the open database that belongs to this site.
 *
 * listEntries returns summaries and leaves custom fields out, which is where a
 * passkey lives, so each entry has to be fetched in full. The values of
 * protected fields are redacted even then, which is why the private key is read
 * separately through getSecret when it is actually needed.
 */
function findForHost(host) {
  if (!host) return [];
  const results = [];
  for (const summary of vault.listEntries({ scope: 'all' }) || []) {
    let entry = null;
    try {
      entry = vault.getEntry(summary.id);
    } catch {
      continue;
    }
    const stored = readStored(entry);
    if (!stored) continue;
    if (!coversHost(stored.relyingParty, host)) continue;
    results.push(stored);
  }
  return results;
}

module.exports = {
  create,
  assertion,
  findForHost,
  readStored,
  coversHost,
  hostOf,
  cbor,
  coseKey,
  authenticatorData,
  b64url,
  fromB64url,
  FIELDS,
  ES256
};
