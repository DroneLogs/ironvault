'use strict';

/**
 * The native messaging host: a pipe between the browser and Propolis.
 *
 * Chrome will not let an extension talk to an application. It will launch a
 * program and exchange messages with it over stdin and stdout, each one a four
 * byte little endian length followed by that many bytes of JSON. So this is
 * launched by the browser, once per message, and forwards to the running copy
 * of Propolis over its named pipe.
 *
 * It holds no keys and understands nothing it carries. The extension encrypts
 * to Propolis and Propolis encrypts back, so a tampered or replaced host still
 * cannot read a password going past. That is deliberate: this file is the part
 * an attacker would find easiest to replace, so it is the part that is worth
 * nothing to them.
 *
 * There is no standalone node in a packaged Electron app, so the launcher runs
 * the Propolis executable with ELECTRON_RUN_AS_NODE set, which makes it behave
 * as a plain node. See browserinstall.js for how that is registered.
 */

const net = require('net');

const PIPE_NAME = '\\\\.\\pipe\\propolis-browser';
const MAX_FRAME = 1024 * 1024;
const REPLY_TIMEOUT_MS = 30000;

function writeFrame(stream, object) {
  const body = Buffer.from(JSON.stringify(object), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  stream.write(Buffer.concat([head, body]));
}

/** Reads exactly one framed message, then stops listening. */
function readOneFrame(stream, onMessage) {
  let buffer = Buffer.alloc(0);
  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length < 4) return;
    const length = buffer.readUInt32LE(0);
    if (length > MAX_FRAME) {
      stream.removeListener('data', onData);
      onMessage(new Error('Message too large'));
      return;
    }
    if (buffer.length < 4 + length) return;
    stream.removeListener('data', onData);
    try {
      onMessage(null, JSON.parse(buffer.subarray(4, 4 + length).toString('utf8')));
    } catch (err) {
      onMessage(err);
    }
  };
  stream.on('data', onData);
}

function fail(message) {
  // Answers in the shape the extension expects, so a browser that cannot reach
  // Propolis shows "Propolis is not running" instead of a silent failure.
  writeFrame(process.stdout, { error: message, code: 'no-app' });
  process.exit(0);
}

function main() {
  readOneFrame(process.stdin, (err, message) => {
    if (err) return fail('The browser sent something unreadable');

    const socket = net.createConnection(PIPE_NAME);
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fail('Propolis did not answer');
    }, REPLY_TIMEOUT_MS);
    if (timer.unref) timer.unref();

    socket.on('connect', () => writeFrame(socket, message));

    readOneFrame(socket, (pipeErr, reply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.end();
      if (pipeErr) return fail('Propolis sent something unreadable');
      writeFrame(process.stdout, reply);
      // Give stdout a moment to flush before the process goes away.
      setTimeout(() => process.exit(0), 50);
    });

    socket.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fail('Propolis is not running. Start it and try again.');
    });
  });

  process.stdin.on('end', () => {
    setTimeout(() => process.exit(0), 100);
  });
}

main();
