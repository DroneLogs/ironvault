'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
let app = null;
try {
  ({ app } = require('electron'));
} catch {
  /* the self test runs this module outside Electron */
}

/**
 * Rolling local backups. Every save drops a timestamped copy into the app's own
 * folder, and the oldest are pruned once the limit is reached. These sit
 * alongside the single .bak written next to the database itself, which only
 * ever holds the version immediately before the last save.
 */

function rootDir() {
  // Outside Electron (the self test) fall back to a temp folder rather than
  // throwing, so a save still succeeds without a backup.
  const base = app && app.getPath ? app.getPath('userData') : path.join(require('os').tmpdir(), 'ironvault');
  return path.join(base, 'backups');
}

/** One folder per database, named from the path so two files can share a name. */
function folderFor(dbPath) {
  const resolved = path.resolve(dbPath);
  const hash = crypto.createHash('sha256').update(resolved.toLowerCase()).digest('hex').slice(0, 12);
  const stem = path.basename(resolved, path.extname(resolved)).replace(/[^\w.-]+/g, '_').slice(0, 40);
  return path.join(rootDir(), stem + '-' + hash);
}

function stamp(date = new Date()) {
  const two = (n) => String(n).padStart(2, '0');
  return (
    date.getFullYear() +
    two(date.getMonth() + 1) +
    two(date.getDate()) +
    '-' +
    two(date.getHours()) +
    two(date.getMinutes()) +
    two(date.getSeconds())
  );
}

async function write(dbPath, buffer, { keep = 10 } = {}) {
  if (!keep || keep < 1) return { written: false, kept: 0 };
  const dir = folderFor(dbPath);
  await fsp.mkdir(dir, { recursive: true });

  const name = stamp() + '.kdbx';
  await fsp.writeFile(path.join(dir, name), buffer);

  const remaining = await prune(dbPath, keep);
  return { written: true, name, kept: remaining };
}

async function list(dbPath) {
  const dir = folderFor(dbPath);
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const entries = [];
  for (const name of names) {
    if (!name.endsWith('.kdbx')) continue;
    try {
      const stats = await fsp.stat(path.join(dir, name));
      entries.push({ name, path: path.join(dir, name), size: stats.size, modified: stats.mtimeMs });
    } catch {
      /* a file vanishing mid listing is not worth failing over */
    }
  }
  entries.sort((a, b) => b.modified - a.modified);
  return entries;
}

async function prune(dbPath, keep) {
  const entries = await list(dbPath);
  for (const old of entries.slice(keep)) {
    try {
      await fsp.unlink(old.path);
    } catch {
      /* ignore */
    }
  }
  return Math.min(entries.length, keep);
}

/** Copies a backup over the live file, keeping the current contents first. */
async function restore(dbPath, backupName) {
  const dir = folderFor(dbPath);
  const source = path.join(dir, path.basename(backupName));
  if (!fs.existsSync(source)) throw new Error('That backup is no longer there');

  if (fs.existsSync(dbPath)) {
    const buffer = await fsp.readFile(dbPath);
    await write(dbPath, buffer, { keep: 20 });
  }
  await fsp.copyFile(source, dbPath);
  return { ok: true, restored: path.basename(backupName) };
}

async function removeAll(dbPath) {
  const dir = folderFor(dbPath);
  try {
    await fsp.rm(dir, { recursive: true, force: true });
  } catch {
    /* nothing to remove */
  }
  return { ok: true };
}

module.exports = { write, list, restore, prune, removeAll, folderFor };
