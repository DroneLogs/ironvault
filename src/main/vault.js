'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const kdbxweb = require('kdbxweb');

const { parseTotpConfig, generateCode } = require('./totp');
const strength = require('./strength');
const backups = require('./backups');
const yubikey = require('./yubikey');

const STANDARD_FIELDS = ['Title', 'UserName', 'Password', 'URL', 'Notes'];

const state = {
  db: null,
  filePath: null,
  keyFilePath: null,
  password: null, // kept so a save does not have to re-prompt for the master key
  yubikey: null, // { slot } when this database is bound to a hardware key
  dirty: false,
  readOnly: false,
  openedAt: 0,
  lastSavedAt: 0
};

/* ------------------------------------------------------------------ helpers */

function requireOpen() {
  if (!state.db) {
    const err = new Error('No database is open');
    err.code = 'LOCKED';
    throw err;
  }
  return state.db;
}

/** Every write goes through here, so read only mode has one place to live. */
function requireWritable() {
  const db = requireOpen();
  if (state.readOnly) {
    const err = new Error('This database is open in read only mode');
    err.code = 'READ_ONLY';
    throw err;
  }
  return db;
}

function fieldText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (value instanceof kdbxweb.ProtectedValue) return value.getText();
  return String(value);
}

function isProtected(value) {
  return value instanceof kdbxweb.ProtectedValue;
}

function toDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

function allGroups(group, acc = []) {
  acc.push(group);
  for (const child of group.groups) allGroups(child, acc);
  return acc;
}

function allEntries(group, acc = []) {
  for (const entry of group.entries) acc.push(entry);
  for (const child of group.groups) allEntries(child, acc);
  return acc;
}

function recycleBinGroup() {
  const db = state.db;
  if (!db || !db.meta.recycleBinUuid) return null;
  return db.getGroup(db.meta.recycleBinUuid) || null;
}

function isInRecycleBin(item) {
  const bin = recycleBinGroup();
  if (!bin) return false;
  let node = item;
  while (node) {
    if (node === bin) return true;
    node = node.parentGroup;
  }
  return false;
}

function findEntry(id) {
  const db = requireOpen();
  for (const entry of allEntries(db.getDefaultGroup())) {
    if (entry.uuid.id === id) return entry;
  }
  return null;
}

function findGroup(id) {
  const db = requireOpen();
  if (!id || id === 'root') return db.getDefaultGroup();
  for (const group of allGroups(db.getDefaultGroup())) {
    if (group.uuid.id === id) return group;
  }
  return null;
}

function customIconDataUrl(item) {
  const db = state.db;
  if (!db || !item.customIcon) return null;
  const icon = db.meta.customIcons.get(item.customIcon.id);
  if (!icon || !icon.data) return null;
  const buf = Buffer.from(icon.data);
  // Sniff the container so the renderer gets a mime type it will actually draw.
  let mime = 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) mime = 'image/jpeg';
  else if (buf.slice(0, 4).toString('ascii') === 'GIF8') mime = 'image/gif';
  else if (buf.slice(0, 4).toString('ascii') === '<svg') mime = 'image/svg+xml';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

function binarySize(binary) {
  const value = binary && binary.value !== undefined ? binary.value : binary;
  if (!value) return 0;
  if (value instanceof kdbxweb.ProtectedValue) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  return 0;
}

function binaryBuffer(binary) {
  const value = binary && binary.value !== undefined ? binary.value : binary;
  if (!value) return Buffer.alloc(0);
  if (value instanceof kdbxweb.ProtectedValue) return Buffer.from(value.getBinary());
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return Buffer.alloc(0);
}

function totpConfigFor(entry) {
  try {
    return parseTotpConfig(entry.fields);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ serialization */

function serializeEntry(entry, { full = false } = {}) {
  const fields = entry.fields;
  const password = fields.get('Password');
  const totp = totpConfigFor(entry);
  const base = {
    id: entry.uuid.id,
    title: fieldText(fields.get('Title')),
    username: fieldText(fields.get('UserName')),
    url: fieldText(fields.get('URL')),
    icon: typeof entry.icon === 'number' ? entry.icon : 0,
    customIcon: customIconDataUrl(entry),
    tags: Array.isArray(entry.tags) ? entry.tags.slice() : [],
    groupId: entry.parentGroup ? entry.parentGroup.uuid.id : null,
    groupName: entry.parentGroup ? entry.parentGroup.name : '',
    hasPassword: Boolean(fieldText(password)),
    hasTotp: Boolean(totp),
    hasNotes: Boolean(fieldText(fields.get('Notes'))),
    attachmentCount: entry.binaries.size,
    inRecycleBin: isInRecycleBin(entry),
    expires: Boolean(entry.times.expires),
    expiryTime: toDate(entry.times.expiryTime),
    expired: Boolean(
      entry.times.expires &&
        entry.times.expiryTime &&
        new Date(entry.times.expiryTime).getTime() < Date.now()
    ),
    created: toDate(entry.times.creationTime),
    modified: toDate(entry.times.lastModTime),
    accessed: toDate(entry.times.lastAccessTime),
    fgColor: entry.fgColor || null,
    bgColor: entry.bgColor || null
  };

  if (!full) return base;

  const custom = [];
  for (const [key, value] of fields) {
    if (STANDARD_FIELDS.includes(key)) continue;
    custom.push({
      key,
      value: isProtected(value) ? '' : fieldText(value),
      protected: isProtected(value)
    });
  }

  return {
    ...base,
    notes: fieldText(fields.get('Notes')),
    passwordStrength: strength.estimate(fieldText(password)),
    customFields: custom,
    attachments: [...entry.binaries.entries()].map(([name, binary]) => ({
      name,
      size: binarySize(binary)
    })),
    history: entry.history
      .map((h, index) => ({
        index,
        title: fieldText(h.fields.get('Title')),
        username: fieldText(h.fields.get('UserName')),
        modified: toDate(h.times.lastModTime)
      }))
      .reverse(),
    autoTypeSequence:
      entry.autoType && entry.autoType.defaultSequence ? entry.autoType.defaultSequence : '',
    totp: totp
      ? { digits: totp.digits, period: totp.period, algorithm: totp.algorithm, issuer: totp.issuer }
      : null
  };
}

function serializeGroup(group) {
  const bin = recycleBinGroup();
  return {
    id: group.uuid.id,
    name: group.name || '',
    icon: typeof group.icon === 'number' ? group.icon : 48,
    customIcon: customIconDataUrl(group),
    notes: group.notes || '',
    expanded: group.expanded !== false,
    isRecycleBin: bin === group,
    entryCount: group.entries.length,
    totalEntryCount: allEntries(group).length,
    groups: group.groups.map(serializeGroup)
  };
}

/* -------------------------------------------------------------- credentials */

async function buildCredentials(password, keyFilePath, yubiConfig) {
  const pv = password ? kdbxweb.ProtectedValue.fromString(password) : null;
  let keyFileBuffer = null;
  if (keyFilePath) {
    const raw = await fsp.readFile(keyFilePath);
    keyFileBuffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  }
  if (!pv && !keyFileBuffer && !yubiConfig) {
    throw new Error('A password, a key file, or a YubiKey is required');
  }

  // kdbxweb asks for the challenge answer on every load and every save, so the
  // key has to stay plugged in for as long as the database is open.
  const challengeFn = yubiConfig ? yubikey.credentialFn(yubiConfig) : undefined;

  return {
    credentials: new kdbxweb.Credentials(pv, keyFileBuffer, challengeFn),
    protectedPassword: pv
  };
}

/* ---------------------------------------------------------------- lifecycle */

async function create({ filePath, password, keyFilePath, name, format = 4, yubikey: yubiConfig }) {
  if (fs.existsSync(filePath)) throw new Error('A file already exists at that location');
  const { credentials, protectedPassword } = await buildCredentials(password, keyFilePath, yubiConfig);
  const db = kdbxweb.Kdbx.create(credentials, name || path.basename(filePath, path.extname(filePath)));
  db.setVersion(format === 3 ? 3 : 4);
  db.meta.generator = 'Propolis';
  db.meta.recycleBinEnabled = true;

  const root = db.getDefaultGroup();
  for (const groupName of ['Internet', 'Email', 'Banking', 'Work']) {
    db.createGroup(root, groupName);
  }

  state.db = db;
  state.filePath = filePath;
  state.keyFilePath = keyFilePath || null;
  state.password = protectedPassword;
  state.yubikey = yubiConfig || null;
  state.dirty = true;
  state.openedAt = Date.now();
  await save();
  return info();
}

async function open({ filePath, password, keyFilePath, readOnly = false, yubikey: yubiConfig }) {
  const raw = await fsp.readFile(filePath);
  const data = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  const { credentials, protectedPassword } = await buildCredentials(password, keyFilePath, yubiConfig);
  let db;
  try {
    db = await kdbxweb.Kdbx.load(data, credentials);
  } catch (err) {
    if (err instanceof kdbxweb.KdbxError && err.code === kdbxweb.Consts.ErrorCodes.InvalidKey) {
      const e = new Error('Wrong password or key file');
      e.code = 'INVALID_KEY';
      throw e;
    }
    throw err;
  }
  state.db = db;
  state.filePath = filePath;
  state.keyFilePath = keyFilePath || null;
  state.password = protectedPassword;
  state.yubikey = yubiConfig || null;
  state.dirty = false;
  state.readOnly = Boolean(readOnly);
  state.openedAt = Date.now();
  state.lastSavedAt = 0;
  return info();
}

function lock() {
  state.db = null;
  state.filePath = null;
  state.keyFilePath = null;
  state.password = null;
  state.yubikey = null;
  state.dirty = false;
  state.readOnly = false;
  state.openedAt = 0;
  state.lastSavedAt = 0;
  if (global.gc) {
    try {
      global.gc();
    } catch {
      /* not exposed, which is fine */
    }
  }
  return { locked: true };
}

function isOpen() {
  return Boolean(state.db);
}

/**
 * Confirms a typed password is the one this database is open with.
 *
 * Used to guard settings that are dangerous rather than to unlock anything, so
 * it compares against the key already in memory instead of reopening the file.
 * A database opened with a key file alone has no password to check, and says so
 * rather than quietly passing.
 */
function verifyMasterPassword(candidate) {
  if (!state.db || !state.password) return false;
  const known = state.password.getText();
  const given = String(candidate == null ? '' : candidate);
  const a = crypto.createHash('sha256').update(known, 'utf8').digest();
  const b = crypto.createHash('sha256').update(given, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

function kdfName(db) {
  try {
    if (db.header.versionMajor < 4) return 'AES-KDF';
    const params = db.header.kdfParameters;
    if (!params) return 'Argon2';
    const uuidVal = params.get('$UUID');
    const bytes = uuidVal && uuidVal.bytes ? uuidVal.bytes : uuidVal;
    const id = bytes ? Buffer.from(bytes).toString('base64') : '';
    const map = {
      [kdbxweb.Consts.KdfId.Argon2d]: 'Argon2d',
      [kdbxweb.Consts.KdfId.Argon2id]: 'Argon2id',
      [kdbxweb.Consts.KdfId.Aes]: 'AES-KDF'
    };
    return map[id] || 'Argon2';
  } catch {
    return 'Unknown';
  }
}

function cipherName(db) {
  try {
    const id = kdbxweb.ByteUtils.bytesToBase64(new Uint8Array(db.header.dataCipherUuid.bytes));
    const map = {
      [kdbxweb.Consts.CipherId.Aes]: 'AES-256',
      [kdbxweb.Consts.CipherId.ChaCha20]: 'ChaCha20'
    };
    return map[id] || 'AES-256';
  } catch {
    return 'AES-256';
  }
}

function info() {
  if (!state.db) return { open: false };
  const db = state.db;
  return {
    open: true,
    filePath: state.filePath,
    fileName: path.basename(state.filePath || ''),
    name: db.meta.name || path.basename(state.filePath || '', '.kdbx'),
    description: db.meta.desc || '',
    version: `${db.header.versionMajor}.${db.header.versionMinor}`,
    kdf: kdfName(db),
    cipher: cipherName(db),
    dirty: state.dirty,
    readOnly: state.readOnly,
    keyChanged: db.meta.keyChanged ? new Date(db.meta.keyChanged).getTime() : null,
    keyFilePath: state.keyFilePath,
    yubikey: state.yubikey ? { slot: state.yubikey.slot } : null,
    entryCount: allEntries(db.getDefaultGroup()).length,
    groupCount: allGroups(db.getDefaultGroup()).filter(
      (g) => g !== db.getDefaultGroup() && !isInRecycleBin(g)
    ).length,
    recycleBinEnabled: Boolean(db.meta.recycleBinEnabled),
    lastSavedAt: state.lastSavedAt
  };
}

async function save({ keepBackups = 10 } = {}) {
  const db = requireWritable();
  if (!state.filePath) throw new Error('This database has no file path');
  const data = await db.save();
  const buffer = Buffer.from(data);
  const dir = path.dirname(state.filePath);
  const tmp = path.join(dir, `.${path.basename(state.filePath)}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  // Write beside the target and rename, so a crash mid-write cannot shred the vault.
  await fsp.writeFile(tmp, buffer);
  if (fs.existsSync(state.filePath)) {
    try {
      await fsp.copyFile(state.filePath, state.filePath + '.bak');
    } catch {
      /* a missing backup should not block the save */
    }
  }
  await fsp.rename(tmp, state.filePath);

  try {
    await backups.write(state.filePath, buffer, { keep: keepBackups });
  } catch (err) {
    console.error('Rolling backup failed: ' + err.message);
  }

  state.dirty = false;
  state.lastSavedAt = Date.now();
  return info();
}

async function saveAs(newPath) {
  requireOpen();
  state.filePath = newPath;
  return save();
}

async function changeCredentials({ password, keyFilePath, yubikey: yubiConfig }) {
  const db = requireOpen();
  const { credentials, protectedPassword } = await buildCredentials(password, keyFilePath, yubiConfig);
  db.credentials = credentials;
  db.meta.keyChanged = new Date();
  state.password = protectedPassword;
  state.keyFilePath = keyFilePath || null;
  state.yubikey = yubiConfig || null;
  state.dirty = true;
  return save();
}

/* -------------------------------------------------------------------- reads */

function getTree() {
  const db = requireOpen();
  const root = db.getDefaultGroup();
  const bin = recycleBinGroup();
  return {
    root: serializeGroup(root),
    counts: {
      all: allEntries(root).filter((e) => !isInRecycleBin(e)).length,
      recycleBin: bin ? allEntries(bin).length : 0
    }
  };
}

function listEntries({ groupId, includeSubgroups = false, scope = 'group' } = {}) {
  const db = requireOpen();
  const root = db.getDefaultGroup();
  let entries;
  if (scope === 'all') {
    entries = allEntries(root).filter((e) => !isInRecycleBin(e));
  } else if (scope === 'recycle') {
    const bin = recycleBinGroup();
    entries = bin ? allEntries(bin) : [];
  } else if (scope === 'expired') {
    entries = allEntries(root).filter(
      (e) =>
        !isInRecycleBin(e) &&
        e.times.expires &&
        e.times.expiryTime &&
        new Date(e.times.expiryTime).getTime() < Date.now()
    );
  } else if (scope === 'totp') {
    entries = allEntries(root).filter((e) => !isInRecycleBin(e) && totpConfigFor(e));
  } else if (scope === 'favorites') {
    entries = allEntries(root).filter(
      (e) => !isInRecycleBin(e) && (e.tags || []).some((t) => /^favou?rite$/i.test(t))
    );
  } else if (scope === 'recent') {
    entries = allEntries(root)
      .filter((e) => !isInRecycleBin(e))
      .sort((a, b) => (toDate(b.times.lastModTime) || 0) - (toDate(a.times.lastModTime) || 0))
      .slice(0, 40);
  } else {
    const group = findGroup(groupId);
    if (!group) return [];
    entries = includeSubgroups ? allEntries(group) : group.entries.slice();
  }
  return entries.map((e) => serializeEntry(e));
}

function search(query, { includeRecycleBin = false } = {}) {
  const db = requireOpen();
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/);
  const results = [];

  for (const entry of allEntries(db.getDefaultGroup())) {
    if (!includeRecycleBin && isInRecycleBin(entry)) continue;
    const title = fieldText(entry.fields.get('Title'));
    const parts = [
      title,
      fieldText(entry.fields.get('UserName')),
      fieldText(entry.fields.get('URL')),
      fieldText(entry.fields.get('Notes')),
      entry.parentGroup ? entry.parentGroup.name : '',
      (entry.tags || []).join(' ')
    ];
    for (const [key, value] of entry.fields) {
      if (STANDARD_FIELDS.includes(key)) continue;
      parts.push(key);
      if (!isProtected(value)) parts.push(fieldText(value));
    }
    const haystack = parts.join('\n').toLowerCase();
    if (!terms.every((t) => haystack.includes(t))) continue;

    const lowerTitle = title.toLowerCase();
    let rank = 3;
    if (lowerTitle === q) rank = 0;
    else if (lowerTitle.startsWith(q)) rank = 1;
    else if (lowerTitle.includes(q)) rank = 2;
    results.push({ rank, entry });
  }

  results.sort(
    (a, b) =>
      a.rank - b.rank ||
      (toDate(b.entry.times.lastModTime) || 0) - (toDate(a.entry.times.lastModTime) || 0)
  );
  return results.slice(0, 300).map((r) => serializeEntry(r.entry));
}

/** Every tag in use, so the editor can offer them for reuse. */
function allTags() {
  const db = requireOpen();
  const tags = new Map();
  for (const entry of allEntries(db.getDefaultGroup())) {
    if (isInRecycleBin(entry)) continue;
    for (const tag of entry.tags || []) {
      const clean = String(tag).trim();
      if (!clean) continue;
      tags.set(clean.toLowerCase(), clean);
    }
  }
  return [...tags.values()].sort((a, b) => a.localeCompare(b));
}

function getEntry(id) {
  const entry = findEntry(id);
  if (!entry) throw new Error('Entry not found');
  entry.times.lastAccessTime = new Date();
  return serializeEntry(entry, { full: true });
}

function getSecret(id, fieldName) {
  const entry = findEntry(id);
  if (!entry) throw new Error('Entry not found');
  return fieldText(entry.fields.get(fieldName));
}

function getTotp(id) {
  const entry = findEntry(id);
  if (!entry) throw new Error('Entry not found');
  const config = totpConfigFor(entry);
  if (!config) return null;
  try {
    return generateCode(config);
  } catch (err) {
    return { error: err.message };
  }
}

function getHistoryEntry(id, index) {
  const entry = findEntry(id);
  if (!entry) throw new Error('Entry not found');
  const historic = entry.history[index];
  if (!historic) throw new Error('History item not found');
  historic.parentGroup = entry.parentGroup;
  return serializeEntry(historic, { full: true });
}

/* ------------------------------------------------------------------- writes */

function markDirty() {
  requireWritable();
  state.dirty = true;
}

function applyEntryFields(entry, payload) {
  const setField = (name, value) => {
    if (value === undefined) return;
    entry.fields.set(name, String(value == null ? '' : value));
  };

  setField('Title', payload.title);
  setField('UserName', payload.username);
  setField('URL', payload.url);
  setField('Notes', payload.notes);

  if (payload.password !== undefined) {
    entry.fields.set('Password', kdbxweb.ProtectedValue.fromString(String(payload.password || '')));
  }

  if (Array.isArray(payload.customFields)) {
    const keep = new Set(payload.customFields.map((f) => f.key));
    for (const key of [...entry.fields.keys()]) {
      if (!STANDARD_FIELDS.includes(key) && !keep.has(key)) entry.fields.delete(key);
    }
    for (const field of payload.customFields) {
      if (!field.key) continue;
      // An untouched protected field arrives blank; leave the stored value alone.
      if (field.unchanged) continue;
      if (field.protected) {
        entry.fields.set(field.key, kdbxweb.ProtectedValue.fromString(String(field.value || '')));
      } else {
        entry.fields.set(field.key, String(field.value == null ? '' : field.value));
      }
    }
  }

  if (Array.isArray(payload.tags)) entry.tags = payload.tags.filter(Boolean);
  if (payload.icon !== undefined) entry.icon = Number(payload.icon) || 0;
  if (payload.expires !== undefined) {
    entry.times.expires = Boolean(payload.expires);
    if (payload.expires && payload.expiryTime) entry.times.expiryTime = new Date(payload.expiryTime);
  }
  if (payload.fgColor !== undefined) entry.fgColor = payload.fgColor || undefined;
  if (payload.bgColor !== undefined) entry.bgColor = payload.bgColor || undefined;
}

function createEntry(payload) {
  const db = requireOpen();
  const group = findGroup(payload.groupId) || db.getDefaultGroup();
  const entry = db.createEntry(group);
  applyEntryFields(entry, payload);
  entry.times.update();
  markDirty();
  return serializeEntry(entry, { full: true });
}

function updateEntry(id, payload) {
  const entry = findEntry(id);
  if (!entry) throw new Error('Entry not found');
  entry.pushHistory();
  applyEntryFields(entry, payload);
  entry.times.update();
  markDirty();
  return serializeEntry(entry, { full: true });
}

function toggleFavorite(id) {
  const entry = findEntry(id);
  if (!entry) throw new Error('Entry not found');
  const tags = entry.tags || [];
  const idx = tags.findIndex((t) => /^favou?rite$/i.test(t));
  if (idx >= 0) tags.splice(idx, 1);
  else tags.push('Favorite');
  entry.tags = tags;
  entry.times.update();
  markDirty();
  return serializeEntry(entry);
}

function deleteEntry(id, { permanent = false } = {}) {
  const db = requireOpen();
  const entry = findEntry(id);
  if (!entry) throw new Error('Entry not found');
  if (permanent || isInRecycleBin(entry) || !db.meta.recycleBinEnabled) {
    db.move(entry, undefined);
  } else {
    db.remove(entry);
  }
  markDirty();
  return { ok: true };
}

function restoreEntry(id, targetGroupId) {
  const db = requireOpen();
  const entry = findEntry(id);
  if (!entry) throw new Error('Entry not found');
  const target = findGroup(targetGroupId) || db.getDefaultGroup();
  db.move(entry, target);
  markDirty();
  return serializeEntry(entry);
}

function moveEntry(id, targetGroupId) {
  const db = requireOpen();
  const entry = findEntry(id);
  const target = findGroup(targetGroupId);
  if (!entry || !target) throw new Error('Entry or group not found');
  db.move(entry, target);
  markDirty();
  return serializeEntry(entry);
}

function duplicateEntry(id) {
  const db = requireOpen();
  const entry = findEntry(id);
  if (!entry) throw new Error('Entry not found');
  const copy = db.createEntry(entry.parentGroup);
  const uuid = copy.uuid;
  copy.copyFrom(entry);
  copy.uuid = uuid;
  copy.fields.set('Title', fieldText(entry.fields.get('Title')) + ' (copy)');
  copy.history = [];
  copy.times.update();
  markDirty();
  return serializeEntry(copy, { full: true });
}

function restoreHistory(id, index) {
  const entry = findEntry(id);
  if (!entry) throw new Error('Entry not found');
  const snapshot = entry.history[index];
  if (!snapshot) throw new Error('History item not found');
  entry.pushHistory();
  entry.copyFrom(snapshot);
  entry.times.update();
  markDirty();
  return serializeEntry(entry, { full: true });
}

function createGroup(parentId, name) {
  const db = requireOpen();
  const parent = findGroup(parentId) || db.getDefaultGroup();
  const group = db.createGroup(parent, name || 'New group');
  markDirty();
  return serializeGroup(group);
}

function updateGroup(id, { name, notes, icon }) {
  const group = findGroup(id);
  if (!group) throw new Error('Group not found');
  if (name !== undefined) group.name = name;
  if (notes !== undefined) group.notes = notes;
  if (icon !== undefined) group.icon = Number(icon) || 48;
  group.times.update();
  markDirty();
  return serializeGroup(group);
}

function deleteGroup(id, { permanent = false } = {}) {
  const db = requireOpen();
  const group = findGroup(id);
  if (!group) throw new Error('Group not found');
  if (group === db.getDefaultGroup()) throw new Error('The root group cannot be deleted');
  if (permanent || isInRecycleBin(group) || !db.meta.recycleBinEnabled) {
    db.move(group, undefined);
  } else {
    db.remove(group);
  }
  markDirty();
  return { ok: true };
}

function moveGroup(id, targetParentId) {
  const db = requireOpen();
  const group = findGroup(id);
  const target = findGroup(targetParentId);
  if (!group || !target) throw new Error('Group not found');
  if (group === target) throw new Error('A group cannot contain itself');
  if (allGroups(group).includes(target)) throw new Error('A group cannot be moved into its own child');
  db.move(group, target);
  markDirty();
  return serializeGroup(group);
}

function emptyRecycleBin() {
  const db = requireOpen();
  const bin = recycleBinGroup();
  if (!bin) return { ok: true, removed: 0 };
  let removed = 0;
  for (const entry of bin.entries.slice()) {
    db.move(entry, undefined);
    removed++;
  }
  for (const group of bin.groups.slice()) {
    db.move(group, undefined);
    removed++;
  }
  markDirty();
  return { ok: true, removed };
}

/* -------------------------------------------------------------- attachments */

async function addAttachment(entryId, filePath) {
  const db = requireOpen();
  const entry = findEntry(entryId);
  if (!entry) throw new Error('Entry not found');
  const raw = await fsp.readFile(filePath);
  const arrayBuffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  const binary = await db.createBinary(arrayBuffer);
  const ext = path.extname(filePath);
  const stem = path.basename(filePath, ext);
  let name = path.basename(filePath);
  let counter = 1;
  while (entry.binaries.has(name)) name = `${stem} (${counter++})${ext}`;
  entry.pushHistory();
  entry.binaries.set(name, binary);
  entry.times.update();
  markDirty();
  return serializeEntry(entry, { full: true });
}

/**
 * Every attachment lives inside the .kdbx, and the whole file is rewritten on
 * every save, so a large one is paid for again on each change and again for
 * each rolling backup kept beside it. Callers use this to say so with real
 * numbers before somebody puts a video in their password database.
 */
function attachmentTotal() {
  const db = requireOpen();
  let bytes = 0;
  let count = 0;
  for (const entry of allEntries(db.getDefaultGroup())) {
    for (const binary of entry.binaries.values()) {
      bytes += binarySize(binary);
      count += 1;
    }
  }
  return { bytes, count };
}

function removeAttachment(entryId, name) {
  const entry = findEntry(entryId);
  if (!entry) throw new Error('Entry not found');
  entry.pushHistory();
  entry.binaries.delete(name);
  entry.times.update();
  markDirty();
  return serializeEntry(entry, { full: true });
}

async function extractAttachment(entryId, name, destPath) {
  const entry = findEntry(entryId);
  if (!entry) throw new Error('Entry not found');
  const binary = entry.binaries.get(name);
  if (!binary) throw new Error('Attachment not found');
  await fsp.writeFile(destPath, binaryBuffer(binary));
  return { ok: true, path: destPath };
}

/* -------------------------------------------------------------------- audit */

function audit() {
  const db = requireOpen();
  const entries = allEntries(db.getDefaultGroup()).filter((e) => !isInRecycleBin(e));
  const byPassword = new Map();
  const weak = [];
  const noPassword = [];
  const expired = [];
  const old = [];
  const twoYearsAgo = Date.now() - 1000 * 60 * 60 * 24 * 365 * 2;

  for (const entry of entries) {
    const pw = fieldText(entry.fields.get('Password'));
    const summary = serializeEntry(entry);
    if (!pw) {
      noPassword.push(summary);
    } else {
      const est = strength.estimate(pw);
      // Anything the scale calls Weak or worse, which is under five words.
      if (est.level <= 2) weak.push({ ...summary, strength: est });
      const list = byPassword.get(pw) || [];
      list.push(summary);
      byPassword.set(pw, list);
    }
    if (
      entry.times.expires &&
      entry.times.expiryTime &&
      new Date(entry.times.expiryTime).getTime() < Date.now()
    ) {
      expired.push(summary);
    }
    const modified = toDate(entry.times.lastModTime);
    if (pw && modified && modified < twoYearsAgo) old.push({ ...summary, modified });
  }

  const duplicates = [];
  for (const [, list] of byPassword) {
    if (list.length > 1) duplicates.push(list);
  }
  duplicates.sort((a, b) => b.length - a.length);

  return {
    total: entries.length,
    weak,
    duplicates,
    noPassword,
    expired,
    old: old.sort((a, b) => a.modified - b.modified)
  };
}

/* ------------------------------------------------------------------ exports */

module.exports = {
  verifyMasterPassword,
  state,
  create,
  open,
  lock,
  isOpen,
  info,
  save,
  saveAs,
  changeCredentials,
  getTree,
  listEntries,
  search,
  allTags,
  getEntry,
  getSecret,
  getTotp,
  getHistoryEntry,
  createEntry,
  updateEntry,
  toggleFavorite,
  deleteEntry,
  restoreEntry,
  moveEntry,
  duplicateEntry,
  restoreHistory,
  createGroup,
  updateGroup,
  deleteGroup,
  moveGroup,
  emptyRecycleBin,
  addAttachment,
  attachmentTotal,
  removeAttachment,
  extractAttachment,
  audit,
  estimateStrength: strength.estimate,
  requireOpen,
  requireWritable,
  serializeEntry,
  fieldText,
  markDirty,
  internals: {
    allEntries,
    allGroups,
    findEntry,
    findGroup,
    isInRecycleBin,
    recycleBinGroup,
    totpConfigFor,
    STANDARD_FIELDS
  }
};
