'use strict';

const fs = require('fs');
const path = require('path');
const { ipcMain, dialog, clipboard, shell, app, safeStorage } = require('electron');

const vault = require('./vault');
const settings = require('./settings');
const generator = require('./generator');
const wordlists = require('./wordlists');
const updater = require('./updater');
const features = require('./features');
const security = require('./security');
const remote = require('./remote');
const sshagent = require('./sshagent');
const autotype = require('./autotype');
const hello = require('./hello');

let ctx = {
  getWindow: () => null,
  lockNow: () => {},
  takePendingFile: () => null,
  applyAppIcon: () => {},
  registerHotkeys: () => {}
};
let clipboardTimer = null;
let clipboardValue = null;

/* -------------------------------------------------------------- clipboard */

function clearClipboardNow() {
  if (clipboardTimer) {
    clearTimeout(clipboardTimer);
    clipboardTimer = null;
  }
  // Only wipe what this app put there; the user may have copied something since.
  if (clipboardValue !== null && clipboard.readText() === clipboardValue) {
    clipboard.clear();
  }
  clipboardValue = null;
}

function copyWithTimeout(text) {
  const seconds = Number(settings.getPrefs().clipboardClearSeconds) || 0;
  clearClipboardNow();
  clipboard.writeText(String(text == null ? '' : text));
  clipboardValue = clipboard.readText();
  if (seconds > 0) {
    clipboardTimer = setTimeout(() => {
      clearClipboardNow();
      const win = ctx.getWindow();
      if (win && !win.isDestroyed()) win.webContents.send('clipboard:cleared');
    }, seconds * 1000);
  }
  return { ok: true, clearAfter: seconds };
}

/* ------------------------------------------------------------ quick unlock */

function quickUnlockAvailable() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function storeQuickUnlock(filePath, password) {
  if (!quickUnlockAvailable()) throw new Error('Windows credential encryption is not available');
  const blob = safeStorage.encryptString(String(password)).toString('base64');
  settings.setQuickUnlock(filePath, blob);
  return { ok: true };
}

function readQuickUnlock(filePath) {
  const record = settings.findDatabase(filePath);
  if (!record || !record.quickUnlock) return null;
  if (!quickUnlockAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(record.quickUnlock, 'base64'));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ dialogs */

function win() {
  return ctx.getWindow();
}

async function chooseDatabaseToOpen() {
  const result = await dialog.showOpenDialog(win(), {
    title: 'Open a KeePass database',
    properties: ['openFile'],
    filters: [
      { name: 'KeePass database', extensions: ['kdbx', 'kdb'] },
      { name: 'All files', extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
}

async function chooseDatabaseToCreate(defaultName) {
  const result = await dialog.showSaveDialog(win(), {
    title: 'Create a new database',
    defaultPath: path.join(app.getPath('documents'), (defaultName || 'My Passwords') + '.kdbx'),
    filters: [{ name: 'KeePass database', extensions: ['kdbx'] }]
  });
  if (result.canceled || !result.filePath) return null;
  return result.filePath.toLowerCase().endsWith('.kdbx') ? result.filePath : result.filePath + '.kdbx';
}

async function chooseKeyFile() {
  const result = await dialog.showOpenDialog(win(), {
    title: 'Select a key file',
    properties: ['openFile'],
    filters: [
      { name: 'Key files', extensions: ['keyx', 'key', 'xml'] },
      { name: 'All files', extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
}

/* ----------------------------------------------------------------- handlers */

const handlers = {
  /* app */
  'app.info': () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: process.platform,
    prefs: settings.getPrefs(),
    quickUnlockAvailable: quickUnlockAvailable(),
    wordLists: wordlists.catalogue(),
    openWith: ctx.takePendingFile()
  }),
  'prefs.get': () => settings.getPrefs(),
  'prefs.set': (patch) => {
    const prefs = settings.setPrefs(patch);
    if ('appIcon' in patch) ctx.applyAppIcon(prefs.appIcon);
    if ('autoTypeHotkey' in patch) ctx.registerHotkeys();
    return prefs;
  },
  'app.iconChoices': () => {
    const dir = path.join(__dirname, '..', '..', 'build');
    const choices = [{ key: 'default', name: 'Ironvault blue' }];
    for (const [key, name] of [
      ['green', 'Green'],
      ['amber', 'Amber'],
      ['crimson', 'Crimson'],
      ['slate', 'Slate']
    ]) {
      if (fs.existsSync(path.join(dir, 'icon-' + key + '.ico'))) choices.push({ key, name });
    }
    return choices;
  },

  /* database list */
  'db.list': () =>
    settings.listDatabases().map((d) => ({
      path: d.path,
      name: d.name,
      keyFilePath: d.keyFilePath || null,
      lastOpened: d.lastOpened || 0,
      exists: fs.existsSync(d.path),
      hasQuickUnlock: Boolean(d.quickUnlock) && quickUnlockAvailable(),
      hasPin: Boolean(d.secrets && d.secrets.pin),
      hasHello: Boolean(d.secrets && d.secrets.hello)
    })),
  'db.forget': ({ filePath }) => {
    settings.forgetDatabase(filePath);
    return { ok: true };
  },
  'db.chooseOpen': () => chooseDatabaseToOpen(),
  'db.chooseNew': ({ name } = {}) => chooseDatabaseToCreate(name),
  'db.chooseKeyFile': () => chooseKeyFile(),

  /* database lifecycle */
  'db.create': async ({ filePath, password, keyFilePath, name, format }) => {
    const info = await vault.create({ filePath, password, keyFilePath, name, format });
    settings.rememberDatabase({ path: filePath, name: name || info.name, keyFilePath: keyFilePath || null });
    return info;
  },
  'db.open': async ({ filePath, password, keyFilePath, rememberQuickUnlock, readOnly }) => {
    let info;
    try {
      info = await vault.open({ filePath, password, keyFilePath, readOnly });
    } catch (err) {
      if (err.code === 'INVALID_KEY' && settings.findDatabase(filePath)) {
        const outcome = security.recordFailure(filePath);
        if (outcome.wipeDue) {
          await security.wipe(filePath);
          const wiped = new Error('Wrong password or key file');
          wiped.code = 'WIPED';
          throw wiped;
        }
      }
      throw err;
    }
    security.resetFailures(filePath);
    settings.rememberDatabase({ path: filePath, name: info.name, keyFilePath: keyFilePath || null });
    if (rememberQuickUnlock && password) storeQuickUnlock(filePath, password);
    return info;
  },
  /**
   * PIN unlock. The duress PIN is checked first and, when it matches, the
   * caller is told nothing that distinguishes it from an ordinary unlock.
   */
  'db.pinUnlock': async ({ filePath, pin }) => {
    const target = filePath;
    const duress = await security.matchesDuress(target, pin);
    if (duress) {
      if (duress.action === 'wipe') {
        await security.wipe(target);
        const err = new Error('Wrong PIN');
        err.code = 'INVALID_KEY';
        throw err;
      }
      const record = settings.findDatabase(duress.dummyPath) || {};
      const info = await vault.open({
        filePath: duress.dummyPath,
        password: record.decoyPassword || '',
        keyFilePath: null
      });
      return { ...info, decoy: true };
    }

    const secrets = settings.getSecrets(target);
    if (!secrets.pin) throw new Error('No PIN is set for this database');

    let password;
    try {
      password = await security.openPassword(pin, secrets.pin);
    } catch {
      const outcome = security.recordFailure(target);
      if (outcome.wipeDue) {
        await security.wipe(target);
        const err = new Error('Wrong PIN');
        err.code = 'WIPED';
        throw err;
      }
      const err = new Error(
        'Wrong PIN' + (outcome.limit ? ' (' + (outcome.limit - outcome.failedAttempts) + ' left)' : '')
      );
      err.code = 'INVALID_KEY';
      throw err;
    }

    const record = settings.findDatabase(target);
    const info = await vault.open({
      filePath: target,
      password,
      keyFilePath: record ? record.keyFilePath : null
    });
    security.resetFailures(target);
    settings.rememberDatabase({ path: target, name: info.name });
    return info;
  },
  'db.helloUnlock': async ({ filePath }) => {
    const record = settings.findDatabase(filePath);
    const password = await security.unlockWithHello(filePath, record ? record.name : '');
    const info = await vault.open({
      filePath,
      password,
      keyFilePath: record ? record.keyFilePath : null
    });
    security.resetFailures(filePath);
    settings.rememberDatabase({ path: filePath, name: info.name });
    return info;
  },
  'db.quickUnlock': async ({ filePath }) => {
    const password = readQuickUnlock(filePath);
    if (!password) {
      const err = new Error('No stored key for this database');
      err.code = 'NO_QUICK_UNLOCK';
      throw err;
    }
    const record = settings.findDatabase(filePath);
    const info = await vault.open({ filePath, password, keyFilePath: record ? record.keyFilePath : null });
    settings.rememberDatabase({ path: filePath, name: info.name });
    return info;
  },
  'db.setQuickUnlock': ({ filePath, password, enabled }) => {
    if (!enabled) {
      settings.setQuickUnlock(filePath, null);
      return { ok: true, enabled: false };
    }
    storeQuickUnlock(filePath, password);
    return { ok: true, enabled: true };
  },
  'db.lock': () => {
    ctx.lockNow('manual');
    return { ok: true };
  },
  'db.info': () => vault.info(),
  'db.save': () => vault.save(),
  'db.saveAs': async () => {
    const target = await chooseDatabaseToCreate(vault.info().name);
    if (!target) return null;
    const info = await vault.saveAs(target);
    settings.rememberDatabase({ path: target, name: info.name });
    return info;
  },
  'db.changeCredentials': ({ password, keyFilePath }) => vault.changeCredentials({ password, keyFilePath }),
  'db.revealInFolder': ({ filePath }) => {
    shell.showItemInFolder(filePath || vault.info().filePath || '');
    return { ok: true };
  },

  /* reading */
  'tree.get': () => vault.getTree(),
  'entries.list': (opts) => vault.listEntries(opts || {}),
  'entries.search': ({ query, includeRecycleBin }) => vault.search(query, { includeRecycleBin }),
  'entries.tags': () => vault.allTags(),
  'entry.get': ({ id }) => vault.getEntry(id),
  'entry.secret': ({ id, field }) => ({ value: vault.getSecret(id, field || 'Password') }),
  'entry.totp': ({ id }) => vault.getTotp(id),
  'entry.history': ({ id, index }) => vault.getHistoryEntry(id, index),

  /* writing */
  'entry.create': (payload) => vault.createEntry(payload),
  'entry.update': ({ id, ...payload }) => vault.updateEntry(id, payload),
  'entry.delete': ({ id, permanent }) => vault.deleteEntry(id, { permanent }),
  'entry.restore': ({ id, groupId }) => vault.restoreEntry(id, groupId),
  'entry.move': ({ id, groupId }) => vault.moveEntry(id, groupId),
  'entry.duplicate': ({ id }) => vault.duplicateEntry(id),
  'entry.favorite': ({ id }) => vault.toggleFavorite(id),
  'entry.restoreHistory': ({ id, index }) => vault.restoreHistory(id, index),

  'group.create': ({ parentId, name }) => vault.createGroup(parentId, name),
  'group.update': ({ id, ...patch }) => vault.updateGroup(id, patch),
  'group.delete': ({ id, permanent }) => vault.deleteGroup(id, { permanent }),
  'group.move': ({ id, parentId }) => vault.moveGroup(id, parentId),
  'recycle.empty': () => vault.emptyRecycleBin(),

  /* attachments */
  'attach.add': async ({ id }) => {
    const result = await dialog.showOpenDialog(win(), {
      title: 'Attach a file',
      properties: ['openFile', 'multiSelections']
    });
    if (result.canceled || !result.filePaths.length) return null;
    let entry = null;
    for (const filePath of result.filePaths) {
      entry = await vault.addAttachment(id, filePath);
    }
    return entry;
  },
  'attach.remove': ({ id, name }) => vault.removeAttachment(id, name),
  'attach.save': async ({ id, name }) => {
    const result = await dialog.showSaveDialog(win(), {
      title: 'Save attachment',
      defaultPath: path.join(app.getPath('downloads'), name)
    });
    if (result.canceled || !result.filePath) return null;
    return vault.extractAttachment(id, name, result.filePath);
  },

  /* tools */
  'audit.run': () => vault.audit(),
  'gen.make': (config) => generator.generate(config),
  'gen.usernames': () => generator.generateUsernames(),
  'gen.wordLists': () => wordlists.catalogue(),
  'gen.strength': ({ password }) => vault.estimateStrength(password),

  /* audits */
  'audit.similar': (opts) => features.auditSimilar(opts || {}),
  'audit.pwned': () =>
    features.auditPwned({
      onProgress: (p) => {
        const win = ctx.getWindow();
        if (win && !win.isDestroyed()) win.webContents.send('progress', { job: 'pwned', ...p });
      }
    }),

  /* icons and favicons */
  'icon.set': ({ id, base64, mime }) => features.setCustomIcon(id, { base64, mime }),
  'icon.clear': ({ id }) => features.clearCustomIcon(id),
  'icon.favicon': ({ id }) => features.downloadFavicon(id),
  'icon.faviconAll': ({ overwrite }) =>
    features.downloadAllFavicons({
      overwrite,
      onProgress: (p) => {
        const win = ctx.getWindow();
        if (win && !win.isDestroyed()) win.webContents.send('progress', { job: 'favicons', ...p });
      }
    }),

  /* placeholders, TOTP */
  'entry.expand': ({ id, field }) => features.expandField(id, field),
  'totp.set': ({ id, ...opts }) => features.setTotp(id, opts),
  'totp.remove': ({ id }) => features.removeTotp(id),
  'totp.uri': ({ id }) => features.totpUri(id),
  'totp.qr': async ({ id }) => {
    const { uri } = features.totpUri(id);
    const qrcode = require('qrcode');
    // An SVG data URL, so the renderer's image policy still holds.
    const svg = await qrcode.toString(uri, { type: 'svg', margin: 1, width: 240 });
    return { uri, svg: 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64') };
  },

  /* compare, merge, import, export */
  'db.compare': (opts) => features.compareWith(opts),
  'db.merge': (opts) => features.mergeWith(opts),
  'db.import': async ({ groupId }) => {
    const result = await dialog.showOpenDialog(win(), {
      title: 'Import entries',
      properties: ['openFile'],
      filters: [
        { name: 'Importable files', extensions: ['csv', 'xml', '1pux'] },
        { name: 'All files', extensions: ['*'] }
      ]
    });
    if (result.canceled || !result.filePaths.length) return null;
    return features.importFrom({ filePath: result.filePaths[0], groupId });
  },
  'db.export': async ({ format }) => {
    const extension = format === 'csv' ? 'csv' : 'xml';
    const result = await dialog.showSaveDialog(win(), {
      title: 'Export entries (unencrypted)',
      defaultPath: path.join(app.getPath('documents'), vault.info().name + '.' + extension),
      filters: [{ name: extension.toUpperCase(), extensions: [extension] }]
    });
    if (result.canceled || !result.filePath) return null;
    return features.exportTo({ filePath: result.filePath, format });
  },
  'db.copyEntriesTo': (opts) => features.copyEntriesToDatabase(opts),
  'db.chooseCompare': async () => {
    const result = await dialog.showOpenDialog(win(), {
      title: 'Choose a database to compare against',
      properties: ['openFile'],
      filters: [{ name: 'KeePass database', extensions: ['kdbx'] }]
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  },

  /* backups */
  'backup.list': () => features.listBackups(),
  'backup.restore': ({ name }) => features.restoreBackup(name),

  /* read only and reminders */
  'db.setReadOnly': ({ readOnly }) => {
    vault.state.readOnly = Boolean(readOnly);
    return vault.info();
  },
  'db.masterKeyAge': () => features.masterKeyAge(),

  /* security: PIN, duress, Windows Hello, app lock */
  'security.status': ({ filePath }) => security.status(filePath || vault.info().filePath),
  'security.setPin': ({ filePath, pin, password }) => security.setPin(filePath || vault.info().filePath, pin, password),
  'security.clearPin': ({ filePath }) => security.clearPin(filePath || vault.info().filePath),
  'security.setDuress': ({ filePath, pin, action, dummyPath }) =>
    security.setDuress(filePath || vault.info().filePath, pin, { action, dummyPath }),
  'security.clearDuress': ({ filePath }) => security.clearDuress(filePath || vault.info().filePath),
  'security.setWipeAfterFails': ({ filePath, count }) =>
    security.setWipeAfterFails(filePath || vault.info().filePath, count),
  'security.setHello': ({ filePath, enabled, password }) =>
    security.setHello(filePath || vault.info().filePath, enabled, password),
  'security.helloAvailability': () => hello.availability({ refresh: true }),
  'security.chooseDummy': async () => {
    const result = await dialog.showOpenDialog(win(), {
      title: 'Choose the decoy database',
      properties: ['openFile'],
      filters: [{ name: 'KeePass database', extensions: ['kdbx'] }]
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  },

  /* remote storage */
  'remote.get': ({ filePath }) => remote.describe(remote.getConfig(filePath || vault.info().filePath)),
  'remote.set': ({ filePath, config }) => remote.setConfig(filePath || vault.info().filePath, config),
  'remote.test': (config) => remote.test(config),
  'remote.sync': () => features.syncNow(),
  'remote.chooseKey': async () => {
    const result = await dialog.showOpenDialog(win(), {
      title: 'Choose an SSH private key',
      properties: ['openFile']
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  },

  /* SSH agent */
  'ssh.status': () => sshagent.status(),
  'ssh.start': () =>
    sshagent.start({
      getKeys: () => (vault.isOpen() ? features.sshKeys() : []),
      notify: (event) => {
        const w = ctx.getWindow();
        if (w && !w.isDestroyed()) w.webContents.send('ssh-agent', event);
      }
    }),
  'ssh.stop': () => sshagent.stop(),
  'ssh.reload': () => sshagent.reload(),

  /* auto-type */
  'autotype.now': (opts) => features.autoTypeNow(opts || {}),
  'autotype.window': () => autotype.foregroundWindow(),
  'autotype.setSequence': ({ id, sequence, window }) => features.setAutoTypeSequence(id, { sequence, window }),
  'autotype.defaultSequence': () => ({ sequence: autotype.DEFAULT_SEQUENCE }),

  /* updates */
  'update.check': ({ manual } = {}) => updater.check({ manual: manual !== false }),
  'update.state': () => updater.state(),
  'update.download': () => updater.download(),
  'update.install': () => updater.installNow(),
  'update.openReleasePage': () => updater.openReleasePage(),

  /* clipboard and shell */
  'clip.copy': ({ text }) => copyWithTimeout(text),
  'clip.copyField': ({ id, field }) => copyWithTimeout(vault.getSecret(id, field)),
  'clip.copyTotp': ({ id }) => {
    const code = vault.getTotp(id);
    if (!code || code.error) throw new Error(code ? code.error : 'This entry has no one time code');
    return copyWithTimeout(code.code);
  },
  'clip.clear': () => {
    clearClipboardNow();
    return { ok: true };
  },
  'shell.openUrl': ({ url }) => {
    const value = String(url || '');
    if (!/^https?:\/\//i.test(value)) throw new Error('Only http and https links can be opened');
    shell.openExternal(value);
    return { ok: true };
  },

  /* confirmation dialogs live in the main process so they are truly modal */
  'ui.confirm': async ({ title, message, detail, confirmLabel, destructive }) => {
    const result = await dialog.showMessageBox(win(), {
      type: destructive ? 'warning' : 'question',
      buttons: [confirmLabel || 'OK', 'Cancel'],
      defaultId: destructive ? 1 : 0,
      cancelId: 1,
      title: title || 'Ironvault',
      message: message || '',
      detail: detail || '',
      noLink: true
    });
    return { confirmed: result.response === 0 };
  },
  'ui.error': async ({ title, message }) => {
    await dialog.showMessageBox(win(), {
      type: 'error',
      buttons: ['OK'],
      title: title || 'Ironvault',
      message: message || ''
    });
    return { ok: true };
  }
};

function registerIpc(context) {
  ctx = { ...ctx, ...context };

  ipcMain.handle('ironvault', async (event, method, args) => {
    const handler = handlers[method];
    if (!handler) throw new Error('Unknown method: ' + method);
    try {
      const result = await handler(args || {});
      return { ok: true, result };
    } catch (err) {
      return {
        ok: false,
        error: { message: err.message || String(err), code: err.code || null }
      };
    }
  });
}

module.exports = { registerIpc, clearClipboardNow };
