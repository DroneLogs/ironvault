'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const kdbxweb = require('kdbxweb');

const vault = require('./vault');
const audit = require('./audit');
const favicon = require('./favicon');
const placeholders = require('./placeholders');
const totp = require('./totp');
const compare = require('./compare');
const transfer = require('./transfer');
const autotype = require('./autotype');
const remote = require('./remote');
const backups = require('./backups');

/**
 * The operations that sit above a single entry: audits that need the whole
 * database, moving data in and out, comparing against another file, syncing,
 * and the desktop integrations.
 */

const { allEntries, findEntry, findGroup, isInRecycleBin, totpConfigFor, STANDARD_FIELDS } = vault.internals;

function liveEntries() {
  const db = vault.requireOpen();
  return allEntries(db.getDefaultGroup()).filter((entry) => !isInRecycleBin(entry));
}

/* ------------------------------------------------------------------ audits */

function auditSimilar({ threshold = 0.7 } = {}) {
  const items = liveEntries().map((entry) => ({
    password: vault.fieldText(entry.fields.get('Password')),
    summary: vault.serializeEntry(entry)
  }));
  return { pairs: audit.findSimilar(items, { threshold }), checked: items.length };
}

async function auditPwned({ onProgress } = {}) {
  const items = liveEntries().map((entry) => ({
    password: vault.fieldText(entry.fields.get('Password')),
    summary: vault.serializeEntry(entry)
  }));
  return audit.checkPwned(items, { onProgress });
}

/* ------------------------------------------------------------------- icons */

function setCustomIcon(entryId, { base64, mime }) {
  const db = vault.requireWritable();
  const entry = findEntry(entryId);
  if (!entry) throw new Error('Entry not found');

  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) throw new Error('That icon is empty');
  if (buffer.length > 256 * 1024) throw new Error('That icon is too large to store');

  const uuid = kdbxweb.KdbxUuid.random();
  db.meta.customIcons.set(uuid.id, {
    data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    name: mime || 'icon',
    lastModified: new Date()
  });
  entry.pushHistory();
  entry.customIcon = uuid;
  entry.times.update();
  vault.markDirty();
  return vault.serializeEntry(entry, { full: true });
}

function clearCustomIcon(entryId) {
  vault.requireWritable();
  const entry = findEntry(entryId);
  if (!entry) throw new Error('Entry not found');
  entry.pushHistory();
  entry.customIcon = undefined;
  entry.times.update();
  vault.markDirty();
  return vault.serializeEntry(entry, { full: true });
}

async function downloadFavicon(entryId) {
  const entry = findEntry(entryId);
  if (!entry) throw new Error('Entry not found');
  const url = vault.fieldText(entry.fields.get('URL'));
  if (!url) throw new Error('That entry has no URL to fetch an icon from');
  const icon = await favicon.fetchFavicon(url);
  setCustomIcon(entryId, { base64: icon.base64, mime: icon.mime });
  return { ok: true, source: icon.source, bytes: icon.bytes, mime: icon.mime };
}

/** Fetches icons for every entry that has a URL and no icon yet. */
async function downloadAllFavicons({ onProgress, overwrite = false } = {}) {
  const targets = liveEntries().filter((entry) => {
    if (!vault.fieldText(entry.fields.get('URL'))) return false;
    return overwrite || !entry.customIcon;
  });

  let done = 0;
  let succeeded = 0;
  const failures = [];

  for (const entry of targets) {
    try {
      await downloadFavicon(entry.uuid.id);
      succeeded++;
    } catch (err) {
      failures.push({ title: vault.fieldText(entry.fields.get('Title')), error: err.message });
    }
    done++;
    if (onProgress) onProgress({ done, total: targets.length });
  }

  return { total: targets.length, succeeded, failures };
}

/* ------------------------------------------------------------ placeholders */

function buildResolver() {
  const db = vault.requireOpen();
  const entries = allEntries(db.getDefaultGroup());
  return {
    getField: (entry, name) => vault.fieldText(entry.fields.get(name)),
    getUuid: (entry) => entry.uuid.id,
    getGroupName: (entry) => (entry.parentGroup ? entry.parentGroup.name : ''),
    findByUuid: (uuid) => entries.find((e) => e.uuid.id === uuid || e.uuid.id === String(uuid).toUpperCase()) || null,
    findByField: (field, value) =>
      entries.find((e) => vault.fieldText(e.fields.get(field)).toLowerCase() === String(value).toLowerCase()) || null
  };
}

function expandField(entryId, fieldName) {
  const entry = findEntry(entryId);
  if (!entry) throw new Error('Entry not found');
  const raw = vault.fieldText(entry.fields.get(fieldName));
  return { raw, value: placeholders.expand(raw, entry, buildResolver()) };
}

/* -------------------------------------------------------------------- TOTP */

function setTotp(entryId, { uri, secret, issuer, account, digits, period, algorithm, steam }) {
  vault.requireWritable();
  const entry = findEntry(entryId);
  if (!entry) throw new Error('Entry not found');

  let finalUri = String(uri || '').trim();
  if (!finalUri) {
    const clean = String(secret || '').toUpperCase().replace(/[\s-]/g, '');
    const check = totp.validateSecret(clean);
    if (!check.ok) throw new Error(check.error);
    finalUri = totp.buildOtpAuthUri({
      secret: clean,
      issuer: issuer || vault.fieldText(entry.fields.get('Title')),
      account: account || vault.fieldText(entry.fields.get('UserName')),
      digits,
      period,
      algorithm,
      steam
    });
  } else if (!/^otpauth:\/\//i.test(finalUri)) {
    throw new Error('That is not an otpauth:// address');
  }

  // Confirm it actually produces a code before it is written.
  const parsed = totp.parseTotpConfig(new Map([['otp', finalUri]]));
  if (!parsed) throw new Error('That one time code setup could not be read');
  totp.generateCode(parsed);

  entry.pushHistory();
  entry.fields.set('otp', finalUri);
  entry.fields.delete('TOTP Seed');
  entry.fields.delete('TOTP Settings');
  entry.times.update();
  vault.markDirty();
  return vault.serializeEntry(entry, { full: true });
}

function removeTotp(entryId) {
  vault.requireWritable();
  const entry = findEntry(entryId);
  if (!entry) throw new Error('Entry not found');
  entry.pushHistory();
  for (const key of ['otp', 'OTP', 'TOTP', 'TOTP Seed', 'TOTP Settings']) entry.fields.delete(key);
  entry.times.update();
  vault.markDirty();
  return vault.serializeEntry(entry, { full: true });
}

/** The otpauth:// address for this entry, for a QR code or another app. */
function totpUri(entryId) {
  const entry = findEntry(entryId);
  if (!entry) throw new Error('Entry not found');
  const raw = vault.fieldText(entry.fields.get('otp'));
  if (/^otpauth:\/\//i.test(raw)) return { uri: raw };

  const config = totpConfigFor(entry);
  if (!config) throw new Error('That entry has no one time code');
  return {
    uri: totp.buildOtpAuthUri({
      secret: config.secret,
      issuer: config.issuer || vault.fieldText(entry.fields.get('Title')),
      account: vault.fieldText(entry.fields.get('UserName')),
      digits: config.digits,
      period: config.period,
      algorithm: config.algorithm,
      steam: config.steam
    })
  };
}

/* --------------------------------------------------------------- auto-type */

function autoTypeCandidates() {
  return liveEntries().map((entry) => ({
    id: entry.uuid.id,
    title: vault.fieldText(entry.fields.get('Title')),
    username: vault.fieldText(entry.fields.get('UserName')),
    url: vault.fieldText(entry.fields.get('URL')),
    autoTypeWindow:
      entry.autoType && entry.autoType.items && entry.autoType.items.length ? entry.autoType.items[0].window : '',
    sequence: (entry.autoType && entry.autoType.defaultSequence) || ''
  }));
}

function autoTypeValues(entryId) {
  const entry = findEntry(entryId);
  if (!entry) throw new Error('Entry not found');
  const resolver = buildResolver();
  const field = (name) => placeholders.expand(vault.fieldText(entry.fields.get(name)), entry, resolver);

  let code = '';
  const config = totpConfigFor(entry);
  if (config) {
    try {
      code = totp.generateCode(config).code;
    } catch {
      /* a broken secret should not stop the rest from being typed */
    }
  }

  return {
    username: field('UserName'),
    password: field('Password'),
    url: field('URL'),
    title: field('Title'),
    notes: field('Notes'),
    totp: code,
    sequence: (entry.autoType && entry.autoType.defaultSequence) || ''
  };
}

async function autoTypeNow({ sequence } = {}) {
  const window = await autotype.foregroundWindow();
  if (!window.title) throw new Error(window.error || 'Could not tell which window is in front');

  const match = autotype.bestMatch(autoTypeCandidates(), window);
  if (!match) {
    const err = new Error('No entry matches "' + window.title + '"');
    err.code = 'NO_MATCH';
    err.window = window;
    throw err;
  }

  const values = autoTypeValues(match.entry.id);
  const chosen = sequence || values.sequence || autotype.DEFAULT_SEQUENCE;
  await autotype.type(chosen, values);

  const entry = findEntry(match.entry.id);
  if (entry) entry.times.lastAccessTime = new Date();

  return { ok: true, title: match.entry.title, window: window.title, sequence: chosen };
}

function setAutoTypeSequence(entryId, { sequence, window }) {
  vault.requireWritable();
  const entry = findEntry(entryId);
  if (!entry) throw new Error('Entry not found');
  entry.pushHistory();
  if (!entry.autoType) entry.autoType = { enabled: true, obfuscation: 0, items: [] };
  entry.autoType.enabled = true;
  entry.autoType.defaultSequence = sequence || undefined;
  entry.autoType.items = window ? [{ window, keystrokeSequence: sequence || '' }] : [];
  entry.times.update();
  vault.markDirty();
  return vault.serializeEntry(entry, { full: true });
}

/* -------------------------------------------------------------- SSH agent */

const SSH_FIELD = /(ssh|private).?key/i;

/** Entries carrying a PEM private key, either as a field or an attachment. */
function sshKeys() {
  const keys = [];
  for (const entry of liveEntries()) {
    const title = vault.fieldText(entry.fields.get('Title'));
    const passphrase = vault.fieldText(entry.fields.get('Password'));

    for (const [name, value] of entry.fields) {
      if (STANDARD_FIELDS.includes(name)) continue;
      if (!SSH_FIELD.test(name)) continue;
      const pem = vault.fieldText(value);
      if (pem.includes('PRIVATE KEY')) keys.push({ pem, passphrase, comment: title + ' (' + name + ')' });
    }

    for (const [name, binary] of entry.binaries) {
      const value = binary && binary.value !== undefined ? binary.value : binary;
      let text = '';
      try {
        if (value instanceof kdbxweb.ProtectedValue) text = Buffer.from(value.getBinary()).toString('utf8');
        else if (value instanceof ArrayBuffer) text = Buffer.from(value).toString('utf8');
        else if (ArrayBuffer.isView(value)) text = Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8');
      } catch {
        continue;
      }
      if (text.includes('PRIVATE KEY')) keys.push({ pem: text, passphrase, comment: title + ' (' + name + ')' });
    }
  }
  return keys;
}

/* ----------------------------------------------------- compare and merge */

async function compareWith({ filePath, password, keyFilePath }) {
  const local = vault.requireOpen();
  const other = await compare.openDatabase({ filePath, password, keyFilePath });
  return compare.compareDatabases(local, other, {
    localName: vault.info().name,
    remoteName: path.basename(filePath)
  });
}

async function mergeWith({ filePath, password, keyFilePath }) {
  const local = vault.requireWritable();
  const before = allEntries(local.getDefaultGroup()).length;
  const other = await compare.openDatabase({ filePath, password, keyFilePath });
  local.merge(other);
  vault.markDirty();
  const after = allEntries(local.getDefaultGroup()).length;
  return { ok: true, entriesBefore: before, entriesAfter: after, added: after - before };
}

/* ------------------------------------------------------- import and export */

function ensureGroup(name) {
  const db = vault.requireWritable();
  const root = db.getDefaultGroup();
  if (!name) return root;
  const existing = root.groups.find((g) => g.name.toLowerCase() === String(name).toLowerCase());
  return existing || db.createGroup(root, String(name));
}

/** Writes plain import records into the open database. */
function addImportedEntries(records, { groupId, groupFromRecord = true } = {}) {
  const db = vault.requireWritable();
  const target = groupId ? findGroup(groupId) : null;
  let added = 0;

  for (const record of records) {
    const group = target || (groupFromRecord ? ensureGroup(record.group || 'Imported') : db.getDefaultGroup());
    const entry = db.createEntry(group);
    entry.fields.set('Title', String(record.title || 'Imported entry'));
    entry.fields.set('UserName', String(record.username || ''));
    entry.fields.set('URL', String(record.url || ''));
    entry.fields.set('Notes', String(record.notes || ''));
    entry.fields.set('Password', kdbxweb.ProtectedValue.fromString(String(record.password || '')));
    if (record.totp) entry.fields.set('otp', String(record.totp));
    if (Array.isArray(record.tags) && record.tags.length) entry.tags = record.tags.slice();
    for (const field of record.customFields || []) {
      if (!field.key) continue;
      entry.fields.set(
        field.key,
        field.protected
          ? kdbxweb.ProtectedValue.fromString(String(field.value || ''))
          : String(field.value == null ? '' : field.value)
      );
    }
    entry.times.update();
    added++;
  }

  vault.markDirty();
  return added;
}

/** Copies every entry out of a KeePass XML export into the open database. */
function addFromXmlDatabase(xmlDb, { groupId } = {}) {
  const records = [];
  for (const entry of allEntries(xmlDb.getDefaultGroup())) {
    const custom = [];
    for (const [key, value] of entry.fields) {
      if (STANDARD_FIELDS.includes(key)) continue;
      custom.push({
        key,
        value: value instanceof kdbxweb.ProtectedValue ? value.getText() : String(value || ''),
        protected: value instanceof kdbxweb.ProtectedValue
      });
    }
    records.push({
      title: compare.fieldText(entry.fields.get('Title')),
      username: compare.fieldText(entry.fields.get('UserName')),
      password: compare.fieldText(entry.fields.get('Password')),
      url: compare.fieldText(entry.fields.get('URL')),
      notes: compare.fieldText(entry.fields.get('Notes')),
      group: entry.parentGroup ? entry.parentGroup.name : 'Imported',
      tags: entry.tags || [],
      customFields: custom
    });
  }
  return addImportedEntries(records, { groupId });
}

async function importFrom({ filePath, groupId }) {
  const result = await transfer.importFile(filePath);
  const added = result.xmlDb
    ? addFromXmlDatabase(result.xmlDb, { groupId })
    : addImportedEntries(result.entries, { groupId });
  return { ok: true, added, source: result.source };
}

/** Flattens the open database for export. Passwords come out in the clear. */
function exportRecords() {
  return liveEntries().map((entry) => ({
    group: entry.parentGroup ? entry.parentGroup.name : '',
    title: vault.fieldText(entry.fields.get('Title')),
    username: vault.fieldText(entry.fields.get('UserName')),
    password: vault.fieldText(entry.fields.get('Password')),
    url: vault.fieldText(entry.fields.get('URL')),
    notes: vault.fieldText(entry.fields.get('Notes')),
    totp: vault.fieldText(entry.fields.get('otp')),
    tags: entry.tags || []
  }));
}

async function exportTo({ filePath, format }) {
  const db = vault.requireOpen();
  if (format === 'csv') {
    await fsp.writeFile(filePath, transfer.exportCsv(exportRecords()), 'utf8');
    return { ok: true, format, entries: exportRecords().length, filePath };
  }
  if (format === 'xml') {
    const xml = await db.saveXml(true);
    await fsp.writeFile(filePath, xml, 'utf8');
    return { ok: true, format, filePath };
  }
  throw new Error('Unknown export format: ' + format);
}

/** Copies entries into a second database file, which stays untouched otherwise. */
async function copyEntriesToDatabase({ ids, filePath, password, keyFilePath, groupName }) {
  const source = vault.requireOpen();
  const target = await compare.openDatabase({ filePath, password, keyFilePath });

  const wanted = new Set(ids);
  const chosen = allEntries(source.getDefaultGroup()).filter((entry) => wanted.has(entry.uuid.id));
  if (!chosen.length) throw new Error('No entries were selected');

  const root = target.getDefaultGroup();
  const name = groupName || 'From ' + vault.info().name;
  const group = root.groups.find((g) => g.name === name) || target.createGroup(root, name);

  for (const entry of chosen) target.importEntry(entry, group, source);

  const data = await target.save();
  await fsp.writeFile(filePath, Buffer.from(data));
  return { ok: true, copied: chosen.length, filePath };
}

/* -------------------------------------------------------------- remote sync */

/**
 * Pull, merge, push. The local file stays authoritative if the remote cannot be
 * reached, which is what makes editing offline safe.
 */
async function syncNow() {
  const local = vault.requireOpen();
  const info = vault.info();
  const config = remote.getConfig(info.filePath);
  if (!config) throw new Error('No remote storage is set up for this database');

  let remoteBuffer;
  try {
    remoteBuffer = await remote.download(info.filePath);
  } catch (err) {
    remote.recordSync(info.filePath, { error: err.message });
    const wrapped = new Error('Could not reach the remote copy: ' + err.message);
    wrapped.code = 'OFFLINE';
    throw wrapped;
  }

  let merged = 0;
  try {
    const data = remoteBuffer.buffer.slice(remoteBuffer.byteOffset, remoteBuffer.byteOffset + remoteBuffer.byteLength);
    const credentials = local.credentials;
    const remoteDb = await kdbxweb.Kdbx.load(data, credentials);
    const before = allEntries(local.getDefaultGroup()).length;
    local.merge(remoteDb);
    merged = allEntries(local.getDefaultGroup()).length - before;
  } catch (err) {
    if (err instanceof kdbxweb.KdbxError && err.code === kdbxweb.Consts.ErrorCodes.InvalidKey) {
      throw new Error('The remote copy uses a different master key');
    }
    throw new Error('The remote copy could not be read: ' + err.message);
  }

  if (!vault.state.readOnly) {
    vault.markDirty();
    await vault.save();
  }

  const outgoing = await fsp.readFile(info.filePath);
  await remote.upload(info.filePath, outgoing);
  remote.recordSync(info.filePath);

  return { ok: true, merged, uploadedBytes: outgoing.length, at: Date.now() };
}

/* ----------------------------------------------------------------- backups */

async function listBackups() {
  return backups.list(vault.info().filePath);
}

async function restoreBackup(name) {
  const info = vault.info();
  if (!info.open) throw new Error('No database is open');
  const filePath = info.filePath;
  vault.lock();
  await backups.restore(filePath, name);
  return { ok: true, filePath };
}

/* ------------------------------------------------- master password reminder */

function masterKeyAge() {
  const info = vault.info();
  if (!info.open || !info.keyChanged) return { known: false, days: null };
  const days = Math.floor((Date.now() - info.keyChanged) / (1000 * 60 * 60 * 24));
  return { known: true, days, changedAt: info.keyChanged };
}

module.exports = {
  auditSimilar,
  auditPwned,
  setCustomIcon,
  clearCustomIcon,
  downloadFavicon,
  downloadAllFavicons,
  expandField,
  setTotp,
  removeTotp,
  totpUri,
  autoTypeCandidates,
  autoTypeValues,
  autoTypeNow,
  setAutoTypeSequence,
  sshKeys,
  compareWith,
  mergeWith,
  importFrom,
  exportTo,
  exportRecords,
  copyEntriesToDatabase,
  syncNow,
  listBackups,
  restoreBackup,
  masterKeyAge,
  liveEntries
};
