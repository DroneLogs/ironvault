/**
 * The extension's half of the conversation with Propolis.
 *
 * Everything sensitive is encrypted here and decrypted in the app, so nothing
 * in between can read it: not the native messaging host, not another process
 * that manages to open the pipe. The key never leaves this service worker.
 *
 * Requests are one shot. sendNativeMessage launches the host, exchanges one
 * message, and lets it exit. A long lived port would be faster but would also
 * keep a service worker alive that Chrome wants to shut down, and this protocol
 * is request and reply anyway.
 *
 * X25519 needs Chrome 133 or newer, which the manifest states. AES-GCM has been
 * everywhere for years. Neither is polyfilled: rolling our own curve
 * arithmetic to support an old browser would be a worse trade than saying no.
 */

const HOST = 'com.skepwright.propolis';
const STORAGE_KEY = 'propolis-identity';

/* ------------------------------------------------------------------- keys */

/**
 * One key pair for the life of the installation. Propolis remembers the public
 * half when the user approves the connection, so losing this means asking for
 * approval again, and stealing it means nothing without also reaching the pipe.
 */
async function identity() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  if (stored[STORAGE_KEY]) {
    const { publicJwk, privateJwk, publicRaw } = stored[STORAGE_KEY];
    return {
      publicRaw,
      privateKey: await crypto.subtle.importKey('jwk', privateJwk, { name: 'X25519' }, true, ['deriveBits']),
      publicKey: await crypto.subtle.importKey('jwk', publicJwk, { name: 'X25519' }, true, [])
    };
  }

  const pair = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const spki = await crypto.subtle.exportKey('spki', pair.publicKey);
  const publicRaw = toBase64(new Uint8Array(spki));

  await chrome.storage.local.set({ [STORAGE_KEY]: { publicJwk, privateJwk, publicRaw } });
  return { publicRaw, privateKey: pair.privateKey, publicKey: pair.publicKey };
}

function toBase64(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(text) {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Same derivation the app does: X25519, then HKDF with a fixed label. */
async function sharedKey(privateKey, appPublicRaw) {
  const appKey = await crypto.subtle.importKey(
    'spki', fromBase64(appPublicRaw), { name: 'X25519' }, false, []
  );
  const bits = await crypto.subtle.deriveBits({ name: 'X25519', public: appKey }, privateKey, 256);
  const base = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode('propolis-browser-v1')
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function seal(key, payload) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const box = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128 },
    key,
    new TextEncoder().encode(JSON.stringify(payload))
  );
  return { nonce: toBase64(nonce), box: toBase64(new Uint8Array(box)) };
}

async function unseal(key, nonce, box) {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(nonce), tagLength: 128 },
    key,
    fromBase64(box)
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

/* --------------------------------------------------------------- messaging */

function sendNative(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(HOST, message, (reply) => {
      if (chrome.runtime.lastError) {
        // The usual cause is that setup was never run for this browser, so the
        // browser has nothing to launch, and that is what the advice assumes.
        // The browser's own words go on the end regardless: when the cause is
        // anything else, they are the only thing that says so, and throwing
        // them away leaves nothing at all to go on.
        const reason = chrome.runtime.lastError.message || 'no reason given';
        const err = new Error(
          'Propolis is not connected to this browser yet. Open Propolis, go to ' +
          'Settings and then Browser extension, and follow the steps there.\n\n' +
          'The browser said: ' + reason
        );
        err.code = 'no-host';
        err.reason = reason;
        reject(err);
        return;
      }
      if (reply && reply.error) {
        const err = new Error(reply.error);
        err.code = reply.code || null;
        reject(err);
        return;
      }
      resolve(reply);
    });
  });
}

/** Handshake every time: the app makes a new key pair each time it starts. */
async function connect() {
  const me = await identity();
  const hello = await sendNative({ action: 'hello', publicKey: me.publicRaw });
  return {
    me,
    appPublicKey: hello.publicKey,
    associated: Boolean(hello.associated),
    key: await sharedKey(me.privateKey, hello.publicKey)
  };
}

async function request(inner) {
  const session = await connect();
  if (!session.associated) {
    const err = new Error('This browser has not been approved in Propolis yet');
    err.code = 'not-associated';
    throw err;
  }
  const sealed = await seal(session.key, inner);
  const reply = await sendNative({ action: 'message', publicKey: session.me.publicRaw, ...sealed });
  return unseal(session.key, reply.nonce, reply.box);
}

/** Asks Propolis to show its approval dialog. The user decides there, not here. */
async function associate() {
  const me = await identity();
  await sendNative({ action: 'hello', publicKey: me.publicRaw });
  const name = navigator.userAgentData?.brands?.map((b) => b.brand).find((b) => !/Not.?A.?Brand/i.test(b));
  return sendNative({
    action: 'associate',
    publicKey: me.publicRaw,
    name: name || 'A browser'
  });
}

/* ----------------------------------------------------------------- routing */

/** Everything the page sent except the routing field, which is ours. */
function strip(message) {
  const copy = { ...message };
  delete copy.type;
  return copy;
}

const ROUTES = {
  status: () => request({ action: 'get-status' }),
  logins: ({ url }) => request({ action: 'get-logins', url }),
  totp: ({ uuid }) => request({ action: 'get-totp', uuid }),
  associate: () => associate(),
  'passkey-create': (m) => request({ action: 'passkey-create', ...strip(m) }),
  'passkey-get': (m) => request({ action: 'passkey-get', ...strip(m) }),
  'passkey-list': ({ url }) => request({ action: 'passkey-list', url }),
  connection: async () => {
    const session = await connect();
    return { associated: session.associated };
  }
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const route = ROUTES[message && message.type];
  if (!route) {
    sendResponse({ ok: false, error: 'Unknown request' });
    return false;
  }
  route(message)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: err.message, code: err.code || null }));
  return true; // keeps the channel open for the async reply
});
