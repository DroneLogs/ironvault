'use strict';

const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const kdbxweb = require('kdbxweb');

/**
 * Import and export: CSV, KeePass XML, and 1Password's .1pux archive.
 *
 * Everything here works on plain objects. Writing them into the open database
 * is vault.js's job, so this file never needs to know how an entry is stored.
 */

/* -------------------------------------------------------------------- CSV */

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  // Strip a byte order mark, which Excel loves to add.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) {
      if (c === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\r') {
      /* handled by the \n that follows */
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

function escapeCsv(value) {
  const text = String(value == null ? '' : value);
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

/** Header names the common exporters use, mapped onto our field names. */
const HEADER_ALIASES = {
  title: ['title', 'name', 'account', 'entry', 'item', 'display name'],
  username: ['username', 'user name', 'login name', 'login', 'user', 'email', 'login_username', 'account name'],
  password: ['password', 'pass', 'login_password'],
  url: ['url', 'web site', 'website', 'uri', 'login_uri', 'link'],
  notes: ['notes', 'comments', 'note', 'notesplain', 'extra', 'comment'],
  group: ['group', 'folder', 'grouping', 'category', 'collection', 'path'],
  totp: ['totp', 'otp', 'login_totp', 'otpauth', 'one-time password'],
  tags: ['tags', 'labels']
};

function mapHeaders(headerRow) {
  const mapping = {};
  headerRow.forEach((raw, index) => {
    const name = String(raw).trim().toLowerCase();
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (mapping[field] === undefined && aliases.includes(name)) {
        mapping[field] = index;
        return;
      }
    }
  });
  return mapping;
}

function importCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) throw new Error('That CSV file is empty');

  const mapping = mapHeaders(rows[0]);
  if (mapping.title === undefined && mapping.username === undefined && mapping.password === undefined) {
    throw new Error('No recognisable columns. Expected a header row with at least a title, username, or password.');
  }

  const unmapped = rows[0]
    .map((h, i) => ({ name: String(h).trim(), index: i }))
    .filter((h) => h.name && !Object.values(mapping).includes(h.index));

  const pick = (row, field) => (mapping[field] === undefined ? '' : String(row[mapping[field]] || '').trim());

  const entries = [];
  for (const row of rows.slice(1)) {
    const entry = {
      title: pick(row, 'title'),
      username: pick(row, 'username'),
      password: pick(row, 'password'),
      url: pick(row, 'url'),
      notes: pick(row, 'notes'),
      group: pick(row, 'group'),
      totp: pick(row, 'totp'),
      tags: pick(row, 'tags')
        .split(/[,;|]/)
        .map((t) => t.trim())
        .filter(Boolean),
      customFields: []
    };
    // Anything we could not place becomes a custom field rather than being lost.
    for (const column of unmapped) {
      const value = String(row[column.index] || '').trim();
      if (value) entry.customFields.push({ key: column.name, value, protected: false });
    }
    if (!entry.title && !entry.username && !entry.password) continue;
    if (!entry.title) entry.title = entry.url || entry.username || 'Imported entry';
    entries.push(entry);
  }

  return { entries, source: 'csv' };
}

function exportCsv(entries) {
  const header = ['Group', 'Title', 'Username', 'Password', 'URL', 'Notes', 'TOTP', 'Tags'];
  const lines = [header.join(',')];
  for (const entry of entries) {
    lines.push(
      [
        entry.group,
        entry.title,
        entry.username,
        entry.password,
        entry.url,
        entry.notes,
        entry.totp,
        (entry.tags || []).join(', ')
      ]
        .map(escapeCsv)
        .join(',')
    );
  }
  return lines.join('\r\n') + '\r\n';
}

/* ------------------------------------------------------------ KeePass XML */

async function importKeePassXml(text) {
  // An unprotected export still needs credentials to build the reader, but any
  // will do, since the XML holds no encrypted payload of its own.
  const credentials = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString('import'));
  const db = await kdbxweb.Kdbx.loadXml(text, credentials);
  return db;
}

/* --------------------------------------------------------------- 1Password */

/**
 * A .1pux file is a zip holding export.data, which is JSON. Node ships no zip
 * reader, so this walks the central directory and inflates the one member it
 * needs. Only the two standard compression methods are handled, which is all
 * 1Password writes.
 */
function readZipEntry(buffer, wantedName) {
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 66000; i--) {
    if (buffer.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('That does not look like a .1pux archive');

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

    if (name === wantedName || name.endsWith('/' + wantedName)) {
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const body = buffer.subarray(start, start + compressedSize);
      if (method === 0) return body;
      if (method === 8) return zlib.inflateRawSync(body);
      throw new Error('Unsupported compression in the archive');
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error('The archive has no ' + wantedName);
}

function importOnePux(buffer) {
  const json = JSON.parse(readZipEntry(buffer, 'export.data').toString('utf8'));
  const entries = [];

  for (const account of json.accounts || []) {
    for (const vault of account.vaults || []) {
      const groupName = (vault.attrs && vault.attrs.name) || 'Imported';
      for (const item of vault.items || []) {
        const overview = (item.item && item.item.overview) || {};
        const details = (item.item && item.item.details) || {};
        if (item.item && item.item.trashed) continue;

        const entry = {
          title: overview.title || 'Imported entry',
          username: '',
          password: '',
          url: overview.url || '',
          notes: details.notesPlain || '',
          group: groupName,
          totp: '',
          tags: overview.tags || [],
          customFields: []
        };

        for (const field of details.loginFields || []) {
          if (field.designation === 'username') entry.username = field.value || '';
          else if (field.designation === 'password') entry.password = field.value || '';
        }

        for (const section of details.sections || []) {
          for (const field of section.fields || []) {
            const value = field.value || {};
            const kind = Object.keys(value)[0];
            const raw = kind ? value[kind] : '';
            if (raw === undefined || raw === null || raw === '') continue;
            if (kind === 'totp') {
              entry.totp = String(raw);
              continue;
            }
            if (!entry.password && kind === 'concealed' && /password/i.test(field.title || '')) {
              entry.password = String(raw);
              continue;
            }
            entry.customFields.push({
              key: field.title || field.id || 'Field',
              value: typeof raw === 'object' ? JSON.stringify(raw) : String(raw),
              protected: kind === 'concealed'
            });
          }
        }

        if (!entry.password && details.password) entry.password = details.password;
        entries.push(entry);
      }
    }
  }

  if (!entries.length) throw new Error('No items were found in that 1Password export');
  return { entries, source: '1pux' };
}

/* ------------------------------------------------------------------ entry */

async function importFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.csv' || extension === '.txt' || extension === '.tsv') {
    return importCsv(await fsp.readFile(filePath, 'utf8'));
  }
  if (extension === '.1pux' || extension === '.zip') {
    return importOnePux(await fsp.readFile(filePath));
  }
  if (extension === '.xml') {
    return { xmlDb: await importKeePassXml(await fsp.readFile(filePath, 'utf8')), source: 'keepass-xml' };
  }
  throw new Error('Propolis can import .csv, .xml, and .1pux files');
}

module.exports = { parseCsv, importCsv, exportCsv, importKeePassXml, importOnePux, importFile, escapeCsv };
