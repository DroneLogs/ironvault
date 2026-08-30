'use strict';

/**
 * YubiKey HMAC-SHA1 challenge-response, over the OTP application's HID
 * interface.
 *
 * The key holds a 20 byte secret you configured in one of its two slots.
 * Ironvault sends a challenge, the key HMACs it and sends back 20 bytes, and
 * that answer becomes part of the database's key. The secret itself never
 * leaves the device, so a copy of the database file is useless without the
 * physical key.
 *
 * Why HID and not WebHID: Chromium refuses HID devices whose top level
 * collection is a keyboard, which is exactly what the OTP interface is, so the
 * browser side API cannot see a YubiKey at all. node-hid ships N-API prebuilds,
 * which load in Electron unchanged, so this needs no compiler.
 *
 * IMPORTANT: this module has not been run against real hardware. The protocol
 * below follows yubikey-personalization, the reference implementation, but
 * every path that talks to a device is unverified. Treat it as a beta, and keep
 * a copy of any database before putting a key on it.
 */

const VENDOR_ID = 0x1050;

const SLOT_CHAL_HMAC1 = 0x30;
const SLOT_CHAL_HMAC2 = 0x38;

const SLOT_WRITE_FLAG = 0x80;
const RESP_PENDING_FLAG = 0x40;
const RESP_TIMEOUT_WAIT_FLAG = 0x20;
const DUMMY_REPORT_WRITE = 0x8f;
const SEQUENCE_MASK = 0x1f;

const FEATURE_REPORT_SIZE = 8;
const PAYLOAD_SIZE = 64;
const FRAME_SIZE = 70; // 64 payload, 1 slot, 2 crc, 3 filler
const CHUNK_SIZE = 7;
const HMAC_RESPONSE_SIZE = 20;

const READ_TIMEOUT_MS = 15000;
const POLL_INTERVAL_MS = 20;

let HID = null;

function loadHid() {
  if (HID) return HID;
  try {
    HID = require('node-hid');
  } catch (err) {
    const error = new Error('YubiKey support is unavailable in this build: ' + err.message);
    error.code = 'NO_HID';
    throw error;
  }
  return HID;
}

/* ------------------------------------------------------------------- CRC16 */

/** The CRC the YubiKey expects: CCITT reversed, seeded with ones. */
function crc16(buffer) {
  let crc = 0xffff;
  for (const byte of buffer) {
    crc ^= byte & 0xff;
    for (let i = 0; i < 8; i++) {
      const carry = crc & 1;
      crc >>= 1;
      if (carry) crc ^= 0x8408;
    }
  }
  return crc & 0xffff;
}

/* ----------------------------------------------------------------- devices */

/**
 * The OTP application presents itself as a keyboard, usage page 1 usage 6.
 * A key may expose several interfaces, and only that one answers this protocol.
 */
function listDevices() {
  const hid = loadHid();
  return hid
    .devices()
    .filter((d) => d.vendorId === VENDOR_ID)
    .filter((d) => d.usagePage === 1 && d.usage === 6)
    .map((d) => ({
      path: d.path,
      product: d.product || 'YubiKey',
      manufacturer: d.manufacturer || 'Yubico',
      productId: d.productId,
      serialNumber: d.serialNumber || null
    }));
}

function detect() {
  try {
    const devices = listDevices();
    return {
      available: true,
      found: devices.length,
      devices,
      message: devices.length
        ? devices.length + (devices.length === 1 ? ' key found' : ' keys found')
        : 'No YubiKey found. Plug one in and try again.'
    };
  } catch (err) {
    return { available: false, found: 0, devices: [], message: err.message };
  }
}

/* ---------------------------------------------------------------- protocol */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** hidapi puts the report id in byte zero, and the YubiKey uses report id 0. */
function writeFeature(device, eightBytes) {
  const report = Buffer.alloc(FEATURE_REPORT_SIZE + 1);
  report[0] = 0;
  eightBytes.copy(report, 1);
  device.sendFeatureReport(report);
}

function readFeature(device) {
  const report = Buffer.from(device.getFeatureReport(0, FEATURE_REPORT_SIZE + 1));
  return report.subarray(1, FEATURE_REPORT_SIZE + 1);
}

function isZero(buffer) {
  return buffer.every((b) => b === 0);
}

/** Clears any half finished exchange so the next one starts clean. */
function resetDevice(device) {
  const report = Buffer.alloc(FEATURE_REPORT_SIZE);
  report[FEATURE_REPORT_SIZE - 1] = DUMMY_REPORT_WRITE;
  try {
    writeFeature(device, report);
  } catch {
    /* nothing useful to do if even the reset fails */
  }
}

async function waitForSlot(device, wantWrite) {
  const deadline = Date.now() + READ_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = readFeature(device);
    const flags = status[FEATURE_REPORT_SIZE - 1];

    if (wantWrite) {
      // Ready to accept the next chunk once nothing is pending.
      if (!(flags & SLOT_WRITE_FLAG) && !(flags & RESP_PENDING_FLAG)) return status;
    } else if (flags & RESP_PENDING_FLAG) {
      if ((flags & SEQUENCE_MASK) !== 0) return status;
      // Sequence zero with the pending flag set means the key gave up.
      throw new Error('The YubiKey reported no response. Is that slot set to HMAC-SHA1?');
    }

    if (flags & RESP_TIMEOUT_WAIT_FLAG) {
      throw new Error('The YubiKey is waiting for a touch. Touch it and try again.');
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error('The YubiKey did not answer in time');
}

/** Sends the 70 byte frame as ten 7 byte chunks, each tagged with its index. */
async function writeFrame(device, payload, slot) {
  const frame = Buffer.alloc(FRAME_SIZE);
  payload.copy(frame, 0, 0, Math.min(payload.length, PAYLOAD_SIZE));
  frame[PAYLOAD_SIZE] = slot;
  frame.writeUInt16LE(crc16(frame.subarray(0, PAYLOAD_SIZE)), PAYLOAD_SIZE + 1);

  for (let i = 0; i < FRAME_SIZE; i += CHUNK_SIZE) {
    const index = i / CHUNK_SIZE;
    const chunk = frame.subarray(i, i + CHUNK_SIZE);

    // Chunks of nothing in the middle are skipped, which is what the firmware
    // expects; the first and last always go.
    const last = i + CHUNK_SIZE >= FRAME_SIZE;
    if (index !== 0 && !last && isZero(chunk)) continue;

    await waitForSlot(device, true);

    const report = Buffer.alloc(FEATURE_REPORT_SIZE);
    chunk.copy(report, 0);
    report[FEATURE_REPORT_SIZE - 1] = SLOT_WRITE_FLAG | index;
    writeFeature(device, report);
  }
}

/** Reads back however many bytes the key has queued, 7 at a time. */
async function readResponse(device, wanted) {
  await waitForSlot(device, false);

  const collected = [];
  const deadline = Date.now() + READ_TIMEOUT_MS;

  while (collected.length * CHUNK_SIZE < wanted + 2 && Date.now() < deadline) {
    const report = readFeature(device);
    const flags = report[FEATURE_REPORT_SIZE - 1];

    if (!(flags & RESP_PENDING_FLAG)) break;
    const sequence = flags & SEQUENCE_MASK;
    if (sequence === 0 && collected.length) break;

    collected.push(Buffer.from(report.subarray(0, CHUNK_SIZE)));
    if (collected.length > 12) break; // far more than any answer needs
  }

  resetDevice(device);

  const body = Buffer.concat(collected);
  if (body.length < wanted) {
    throw new Error('The YubiKey returned a short answer. Is that slot set to HMAC-SHA1?');
  }

  const response = body.subarray(0, wanted);

  // The two bytes after the answer are its CRC, so a garbled exchange is caught
  // rather than silently producing the wrong key.
  if (body.length >= wanted + 2) {
    const expected = body.readUInt16LE(wanted);
    const actual = crc16(response);
    if (expected !== 0 && expected !== actual) {
      throw new Error('The answer from the YubiKey failed its checksum');
    }
  }

  return response;
}

/* ------------------------------------------------------------------- public */

/**
 * Sends one challenge and returns the 20 byte answer. The challenge is placed
 * at the front of a zero filled 64 byte payload, which is what
 * yubikey-personalization does.
 */
async function challengeResponse(challenge, { slot = 2, devicePath } = {}) {
  const hid = loadHid();
  const buffer = Buffer.isBuffer(challenge) ? challenge : Buffer.from(challenge);
  if (!buffer.length || buffer.length > PAYLOAD_SIZE) {
    throw new Error('A challenge must be between 1 and 64 bytes');
  }

  const devices = listDevices();
  if (!devices.length) throw new Error('No YubiKey found. Plug one in and try again.');
  const target = devicePath ? devices.find((d) => d.path === devicePath) : devices[0];
  if (!target) throw new Error('That YubiKey is no longer connected');

  const payload = Buffer.alloc(PAYLOAD_SIZE);
  buffer.copy(payload, 0);

  let device;
  try {
    device = new hid.HID(target.path);
  } catch (err) {
    throw new Error('Could not open the YubiKey: ' + err.message);
  }

  try {
    resetDevice(device);
    await writeFrame(device, payload, slot === 1 ? SLOT_CHAL_HMAC1 : SLOT_CHAL_HMAC2);
    return await readResponse(device, HMAC_RESPONSE_SIZE);
  } finally {
    try {
      device.close();
    } catch {
      /* already gone */
    }
  }
}

/**
 * The function shape kdbxweb wants for a challenge-response credential. Wrapped
 * so a missing key produces a clear message rather than a protocol error.
 */
function credentialFn({ slot = 2, devicePath } = {}) {
  return async (challenge) => {
    const answer = await challengeResponse(Buffer.from(challenge), { slot, devicePath });
    return new Uint8Array(answer);
  };
}

/** Round trips a fixed challenge so the user can prove their key works. */
async function selfTest({ slot = 2, devicePath } = {}) {
  const challenge = Buffer.from('Propolis challenge response test', 'utf8');
  const started = Date.now();
  const answer = await challengeResponse(challenge, { slot, devicePath });
  return {
    ok: true,
    slot,
    bytes: answer.length,
    // The answer is a fingerprint of a secret, so only a prefix is shown.
    preview: answer.toString('hex').slice(0, 12),
    tookMs: Date.now() - started
  };
}

module.exports = {
  detect,
  listDevices,
  challengeResponse,
  credentialFn,
  selfTest,
  crc16,
  VENDOR_ID
};
