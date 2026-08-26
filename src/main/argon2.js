'use strict';

const kdbxweb = require('kdbxweb');
const { argon2d, argon2id } = require('hash-wasm');

const ARGON2_VERSION_13 = 0x13;

function toUint8(buf) {
  if (buf instanceof Uint8Array) return buf;
  return new Uint8Array(buf);
}

/**
 * kdbxweb ships no Argon2 implementation of its own, so KDBX 4 files cannot be
 * opened until one is registered. hash-wasm is a pure WASM build that runs the
 * same in the Electron main process as it would in a browser.
 */
function registerArgon2() {
  kdbxweb.CryptoEngine.setArgon2Impl(
    async (password, salt, memory, iterations, length, parallelism, type, version) => {
      if (version !== ARGON2_VERSION_13) {
        throw new Error('Unsupported Argon2 version: ' + version);
      }
      const hashFn = type === kdbxweb.CryptoEngine.Argon2TypeArgon2d ? argon2d : argon2id;
      const hash = await hashFn({
        password: toUint8(password),
        salt: toUint8(salt),
        parallelism: Math.max(1, parallelism),
        iterations: Math.max(1, iterations),
        memorySize: Math.max(8, Math.round(memory / 1024)),
        hashLength: length,
        outputType: 'binary'
      });
      const bytes = toUint8(hash);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
  );
}

module.exports = { registerArgon2 };
