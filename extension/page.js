/**
 * Replaces navigator.credentials on the page.
 *
 * This runs in the page's own world rather than the extension's, because a
 * content script has a separate copy of the globals and replacing them there is
 * invisible to the site. It is injected by content.js.
 *
 * Sites call navigator.credentials.create and .get for passkeys. Both are
 * intercepted, sent to Propolis, and answered with an object shaped like the
 * PublicKeyCredential the browser would have returned. If Propolis has nothing
 * to offer, the original function is called instead, so a security key or
 * Windows Hello still works exactly as before. Refusing to fall back would mean
 * installing this extension quietly broke every passkey the user already had.
 */

(function () {
  'use strict';

  if (window.__propolisPasskeys) return; // already installed on this page
  window.__propolisPasskeys = true;

  const original = {
    create: navigator.credentials && navigator.credentials.create.bind(navigator.credentials),
    get: navigator.credentials && navigator.credentials.get.bind(navigator.credentials)
  };
  if (!original.create || !original.get) return;

  const CHANNEL = 'propolis-passkey';
  let counter = 0;

  function ask(action, payload) {
    return new Promise((resolve) => {
      const id = CHANNEL + ':' + ++counter;
      function onMessage(event) {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.channel !== CHANNEL || data.id !== id || !data.reply) return;
        window.removeEventListener('message', onMessage);
        resolve(data);
      }
      window.addEventListener('message', onMessage);
      window.postMessage({ channel: CHANNEL, id, action, payload }, window.location.origin);

      // A content script that never answers must not hang the page forever.
      setTimeout(() => {
        window.removeEventListener('message', onMessage);
        resolve({ ok: false, error: 'Propolis did not answer' });
      }, 120000);
    });
  }

  function toB64url(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function fromB64url(text) {
    const padded = String(text).replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }

  /**
   * Sites check the prototype, and some refuse anything that is not a real
   * PublicKeyCredential. The object is given the right prototype and the
   * ArrayBuffers the specification promises, since a base64 string where bytes
   * were expected is the most common way a shim like this falls over.
   */
  function buildCredential(data, isCreate) {
    const response = isCreate
      ? Object.create(AuthenticatorAttestationResponse.prototype, {
          clientDataJSON: { value: fromB64url(data.response.clientDataJSON).buffer, enumerable: true },
          attestationObject: { value: fromB64url(data.response.attestationObject).buffer, enumerable: true },
          getTransports: { value: () => data.response.transports || ['internal'] }
        })
      : Object.create(AuthenticatorAssertionResponse.prototype, {
          clientDataJSON: { value: fromB64url(data.response.clientDataJSON).buffer, enumerable: true },
          authenticatorData: { value: fromB64url(data.response.authenticatorData).buffer, enumerable: true },
          signature: { value: fromB64url(data.response.signature).buffer, enumerable: true },
          userHandle: {
            value: data.response.userHandle ? fromB64url(data.response.userHandle).buffer : null,
            enumerable: true
          }
        });

    return Object.create(PublicKeyCredential.prototype, {
      id: { value: data.id, enumerable: true },
      rawId: { value: fromB64url(data.rawId).buffer, enumerable: true },
      type: { value: 'public-key', enumerable: true },
      authenticatorAttachment: { value: 'platform', enumerable: true },
      response: { value: response, enumerable: true },
      getClientExtensionResults: { value: () => ({}) }
    });
  }

  async function propolisCreate(options) {
    if (!options || !options.publicKey) return original.create(options);
    const pub = options.publicKey;

    const reply = await ask('create', {
      origin: window.location.origin,
      rpId: (pub.rp && pub.rp.id) || window.location.hostname,
      rpName: (pub.rp && pub.rp.name) || '',
      userName: (pub.user && pub.user.name) || '',
      userDisplayName: (pub.user && pub.user.displayName) || '',
      userHandle: pub.user && pub.user.id ? toB64url(pub.user.id) : null,
      challenge: toB64url(pub.challenge)
    });

    if (!reply.ok) {
      // Anything Propolis will not or cannot do falls back to the browser, so
      // a security key still works and declining does not strand the user.
      if (reply.code === 'declined') throw new DOMException(reply.error, 'NotAllowedError');
      return original.create(options);
    }
    return buildCredential(reply.data.credential, true);
  };

  async function propolisGet(options) {
    if (!options || !options.publicKey) return original.get(options);

    // Conditional mediation is the browser's own autofill: the site asks quietly
    // and the browser offers passkeys inside the username field. That interface
    // belongs to the browser and cannot be drawn from a page script, so this is
    // handed straight back. Intercepting it would replace a silent offer with an
    // unprompted dialog, which is worse than not being involved.
    if (options.mediation === 'conditional') return original.get(options);

    const pub = options.publicKey;

    const allowCredentials = Array.isArray(pub.allowCredentials)
      ? pub.allowCredentials.map((c) => toB64url(c.id))
      : [];

    const reply = await ask('get', {
      origin: window.location.origin,
      rpId: pub.rpId || window.location.hostname,
      challenge: toB64url(pub.challenge),
      allowCredentials
    });

    if (!reply.ok) {
      if (reply.code === 'declined') throw new DOMException(reply.error, 'NotAllowedError');
      return original.get(options);
    }
    return buildCredential(reply.data.credential, false);
  };

  /**
   * Installs the two overrides, and puts them back if something replaces them.
   *
   * Another password manager's extension does exactly what this one does, and
   * whichever script runs last wins. That is why a site can end up talking to
   * 1Password while Propolis never hears the request at all. Re-asserting a few
   * times after load makes this the one holding the wire in the common case.
   *
   * It is bounded on purpose. Two extensions re-asserting forever would be a
   * fight neither can win and would burn a page's main thread doing it. If
   * another manager is genuinely installed and wanted for a site, the answer is
   * to turn one of them off, not to escalate.
   */
  function install() {
    if (navigator.credentials.create !== propolisCreate) {
      navigator.credentials.create = propolisCreate;
    }
    if (navigator.credentials.get !== propolisGet) {
      navigator.credentials.get = propolisGet;
    }
    // Sites ask this before offering a passkey button. Propolis is a platform
    // authenticator as far as the page is concerned, so the answer is yes.
    if (window.PublicKeyCredential) {
      PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = async () => true;
    }
  }

  install();
  let reasserts = 0;
  const keepHold = setInterval(() => {
    install();
    if (++reasserts >= 20) clearInterval(keepHold);
  }, 250);
  document.addEventListener('DOMContentLoaded', install, { once: true });

  // Lets the popup say which manager currently holds the wire, so "it went to
  // the other one" is answerable rather than a mystery.
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.channel !== 'propolis-passkey-probe') return;
    window.postMessage(
      {
        channel: 'propolis-passkey-probe',
        reply: true,
        holding: navigator.credentials.get === propolisGet
      },
      window.location.origin
    );
  });
})();
