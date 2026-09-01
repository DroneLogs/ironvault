'use strict';

const fs = require('fs');
const path = require('path');
const { ipcMain, dialog, clipboard, shell, app, safeStorage, nativeTheme } = require('electron');

const vault = require('./vault');
const capture = require('./capture');
const approval = require('./approval');
const aliases = require('./aliases');
const browserbridge = require('./browserbridge');
const browserinstall = require('./browserinstall');
const lansync = require('./lansync');
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
const brand = require('./brand');
const itemtypes = require('./itemtypes');
const yubikey = require('./yubikey');

let ctx = {
  getWindow: () => null,
  lockNow: () => {},
  takePendingFile: () => null,
  applyAppIcon: () => {},
  applyTitleBarColors: () => {},
  applyAppearance: () => {},
  applyZoom: () => {},
  applyScreenCapture: () => {},
  relaunch: () => {},
  registerHotkeys: () => {}
};
let clipboardTimer = null;
let clipboardValue = null;

/**
 * Above this, adding a file asks first. A .kdbx carries its attachments inside
 * itself and is rewritten whole on every save, so the cost is paid again on
 * each change and again for each backup kept. Five megabytes is small enough
 * to be harmless and large enough that nobody meets this by accident.
 */
const ATTACHMENT_WARN_BYTES = 5 * 1024 * 1024;

function formatSize(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
  return bytes + ' bytes';
}

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

/**
 * Windows keeps a clipboard history (Win+V) and can sync it to other machines.
 * Both are off by default, and both record anything this app copies when on.
 *
 * The proper fix is to mark the clipboard item with the Windows formats that
 * opt out of history and cloud sync. Electron cannot: every clipboard write it
 * offers clears the clipboard first, so the text and the exclusion formats
 * cannot be set together. Verified against Electron 33, not assumed.
 *
 * So we detect it and say so instead of failing quietly. Reading two registry
 * values is cheap and needs no native code.
 */
let clipboardRiskCache = null;

function clipboardHistoryRisk() {
  if (clipboardRiskCache !== null) return clipboardRiskCache;
  const result = { history: false, cloud: false, checked: false };
  if (process.platform !== 'win32') {
    clipboardRiskCache = result;
    return result;
  }
  try {
    const { execFileSync } = require('child_process');
    const read = (name) => {
      try {
        const out = execFileSync(
          'reg',
          ['query', 'HKCU\\Software\\Microsoft\\Clipboard', '/v', name],
          { encoding: 'utf8', timeout: 4000, windowsHide: true }
        );
        const match = out.match(/0x([0-9a-f]+)/i);
        return !!match && parseInt(match[1], 16) === 1;
      } catch {
        return false; // absent means the feature was never turned on
      }
    };
    result.history = read('EnableClipboardHistory');
    result.cloud = read('CloudClipboardAutomaticUpload');
    result.checked = true;
  } catch (err) {
    console.error('Could not read clipboard settings: ' + err.message);
  }
  clipboardRiskCache = result;
  return result;
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

/**
 * YubiKey is off unless the user turned it on. The check lives here rather than
 * only in the interface, so hiding a button is not the only thing standing
 * between an unverified code path and somebody's database.
 */
function requireYubikeyBeta() {
  if (!settings.getPrefs().yubikeyBeta) {
    throw new Error('YubiKey support is off. Turn it on in Settings, under YubiKey.');
  }
}

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

/* ------------------------------------------------------------ site icons */

/**
 * Fetches a site's icon straight after a save, so adding a URL is all it takes.
 *
 * Downloading one was already possible, but only by asking for it on each entry
 * or running the whole database through the tool, which meant most entries kept
 * their coloured initials forever.
 *
 * Three things it deliberately does not do. It never replaces an icon that is
 * already there, because that would overwrite one the user chose. It never
 * makes the save wait, or fail: a site being down is not a reason for saving a
 * password to go wrong. And it does nothing at all when the setting is off,
 * since fetching an icon tells that site somebody here has an entry for it.
 */
function autoFetchIcon(entryId, url) {
  if (!entryId || !url) return;
  if (settings.getPrefs().autoFetchFavicons === false) return;

  let existing = null;
  try {
    existing = vault.getEntry(entryId);
  } catch {
    return;
  }
  if (!existing || existing.customIcon) return;

  setImmediate(async () => {
    try {
      await features.downloadFavicon(entryId);
      const target = ctx.getWindow();
      if (target && !target.isDestroyed()) target.webContents.send('icon-updated', { id: entryId });
    } catch {
      // No icon, no network, or nothing that decodes. All ordinary.
    }
  });
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
    productName: brand.productNameFor(settings.getPrefs().theme),
    iconKey: brand.iconKeyFor(settings.getPrefs().theme),
    systemDark: nativeTheme.shouldUseDarkColors,
    itemTypes: itemtypes.choices(),
    itemTypeField: itemtypes.TYPE_FIELD,
    tagline: brand.taglineFor(settings.getPrefs().theme),
    openWith: ctx.takePendingFile()
  }),
  'app.relaunch': () => {
    ctx.relaunch();
    return { ok: true };
  },
  'prefs.get': () => settings.getPrefs(),
  'prefs.set': (patch) => {
    const prefs = settings.setPrefs(patch);
    if ('theme' in patch) ctx.applyAppIcon(prefs.theme);
    if ('appearance' in patch) ctx.applyAppearance(prefs.appearance);
    if ('zoom' in patch) ctx.applyZoom(prefs.zoom);
    if ('autoTypeHotkey' in patch) ctx.registerHotkeys();
    return prefs;
  },
  'app.themes': () => brand.choices(),

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
  'db.create': async ({ filePath, password, keyFilePath, name, format, yubikey: yubiConfig }) => {
    const info = await vault.create({ filePath, password, keyFilePath, name, format, yubikey: yubiConfig });
    settings.rememberDatabase({ path: filePath, name: name || info.name, keyFilePath: keyFilePath || null });
    if (yubiConfig) settings.setSecrets(filePath, { yubikey: yubiConfig });
    return info;
  },
  'db.open': async ({ filePath, password, keyFilePath, rememberQuickUnlock, readOnly }) => {
    let info;
    const yubiConfig = settings.getSecrets(filePath).yubikey || null;
    try {
      info = await vault.open({ filePath, password, keyFilePath, readOnly, yubikey: yubiConfig });
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
  'db.changeCredentials': ({ password, keyFilePath, yubikey: yubiConfig }) =>
    vault.changeCredentials({ password, keyFilePath, yubikey: yubiConfig }),
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
  'entry.create': (payload) => {
    const created = vault.createEntry(payload);
    autoFetchIcon(created && created.id, payload.url);
    return created;
  },
  'entry.update': ({ id, ...payload }) => {
    const updated = vault.updateEntry(id, payload);
    autoFetchIcon(id, payload.url);
    return updated;
  },
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

    let incoming = 0;
    for (const filePath of result.filePaths) {
      try {
        incoming += fs.statSync(filePath).size;
      } catch {
        /* an unreadable file fails properly a moment later */
      }
    }
    if (incoming >= ATTACHMENT_WARN_BYTES) {
      const existing = vault.attachmentTotal();
      const already =
        existing.count === 0
          ? 'This database carries no attachments yet.'
          : 'This database already carries ' +
            formatSize(existing.bytes) +
            ' across ' +
            existing.count +
            ' attachment' +
            (existing.count === 1 ? '' : 's') +
            '.';
      const answer = await dialog.showMessageBox(win(), {
        type: 'warning',
        buttons: ['Attach anyway', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        title: 'Large attachment',
        message: 'Attach ' + formatSize(incoming) + ' to this entry?',
        detail:
          'Attachments are stored inside the database file itself. ' +
          already +
          ' The whole file is written out again every time anything changes, and once ' +
          'more for each backup kept beside it, so anything large is usually better off ' +
          'somewhere else on disk.',
        noLink: true
      });
      if (answer.response !== 0) return null;
    }

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
  'gen.usernames': () =>
    generator.generateUsernames({
      includeInventedEmail: settings.getPrefs().allowInventedEmail === true
    }),

  /* travel vaults */
  'travel.candidates': ({ tag } = {}) => features.travelCandidates({ tag }),
  'travel.export': async ({ tag, name, password }) => {
    const target = await dialog.showSaveDialog(win(), {
      title: 'Save the travel database',
      defaultPath: path.join(app.getPath('documents'), (name || 'Travel') + '.kdbx'),
      filters: [{ name: 'KeePass database', extensions: ['kdbx'] }]
    });
    if (target.canceled || !target.filePath) return null;
    const filePath = target.filePath.toLowerCase().endsWith('.kdbx')
      ? target.filePath
      : target.filePath + '.kdbx';
    return features.exportTravelVault({ filePath, password, tag, name });
  },

  /* sync over the local network */
  'lan.status': () => lansync.status(),
  'lan.enable': ({ enabled }) => {
    settings.setPrefs({ lanSync: enabled !== false });
    return enabled !== false ? lansync.start() : lansync.stop();
  },
  'lan.beginPairing': () => {
    lansync.startAnnouncing();
    return lansync.beginPairing({});
  },
  'lan.cancelPairing': () => {
    lansync.stopAnnouncing();
    return lansync.cancelPairing();
  },
  'lan.discover': () => lansync.discover({}),
  'lan.pair': ({ address, port, code, name }) => lansync.pairWith({ address, port, code, name }),
  'lan.forget': ({ id }) => lansync.forgetPeer(id),
  'lan.setName': ({ name }) => {
    settings.setPrefs({ lanDeviceName: String(name || '').slice(0, 60) });
    return lansync.status();
  },
  'lan.sync': ({ peerId }) => features.lanSyncNow({ peerId }),

  /* approval prompts drawn by the renderer */
  'approval.answer': (args) => approval.answer(args),

  /* browser extension */
  'browser.status': async () => ({
    ...browserbridge.status(),
    enabled: settings.getPrefs().browserBridge === true,
    install: await browserinstall.status()
  }),
  'browser.enable': ({ enabled }) => {
    settings.setPrefs({ browserBridge: enabled !== false });
    return enabled !== false ? browserbridge.start() : browserbridge.stop();
  },
  'browser.forget': ({ id }) => browserbridge.forget(id),
  'browser.register': ({ browser, extensionId }) =>
    browserinstall.install({ browser, extensionId }),
  'browser.unregister': ({ browser }) => browserinstall.uninstall({ browser }),
  'browser.reveal': () => browserinstall.revealExtension(),

  /* email aliases from a provider that actually issues them */
  'alias.status': () => aliases.status(),
  'alias.verify': ({ provider, apiKey }) => aliases.verify({ provider, apiKey }),
  'alias.saveKey': ({ provider, apiKey }) => aliases.storeKey(provider, apiKey),
  'alias.clearKey': ({ provider }) => aliases.clearKey(provider),
  'alias.create': ({ provider, note, hostname, domain }) =>
    aliases.create({ provider, note, hostname, domain }),
  'gen.wordLists': () => wordlists.catalogue(),
  'gen.strength': ({ password }) => vault.estimateStrength(password),

  /* YubiKey */
  'yubikey.detect': () => {
    requireYubikeyBeta();
    return yubikey.detect();
  },
  'yubikey.test': ({ slot }) => {
    requireYubikeyBeta();
    return yubikey.selfTest({ slot: Number(slot) || 2 });
  },
  'yubikey.get': ({ filePath }) => {
    const secrets = settings.getSecrets(filePath || vault.info().filePath);
    return secrets.yubikey || null;
  },
  'yubikey.set': ({ filePath, slot, enabled }) => {
    if (enabled) requireYubikeyBeta();
    settings.setSecrets(filePath || vault.info().filePath, {
      yubikey: enabled ? { slot: Number(slot) || 2 } : null
    });
    return { ok: true, enabled: Boolean(enabled) };
  },

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
  'clip.risk': () => clipboardHistoryRisk(),
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
      title: title || 'Propolis',
      message: message || '',
      detail: detail || '',
      noLink: true
    });
    return { confirmed: result.response === 0 };
  },
  /**
   * The window controls are drawn by Windows. The renderer reports what the
   * title bar actually computed to after a theme change, and it is passed on
   * unchanged, so the buttons never sit on the wrong colour.
   */
  /* The renderer says when a secret is on screen. Only the unlessRevealed
     setting acts on it, but it is always reported so that switching to
     that setting takes effect without needing a reveal first. */
  /* screen capture, which is a grant rather than a setting: see capture.js */
  'capture.status': () => capture.status(),
  'capture.request': ({ mode, credential, minutes }) => capture.request({ mode, credential, minutes }),
  'capture.revoke': () => capture.revoke('user'),
  'capture.setGuard': ({ guard }) => capture.setGuard(guard),
  'capture.setMinutes': ({ minutes }) => capture.setGrantMinutes(minutes),
  'capture.setPassword': ({ password }) => capture.setSeparatePassword(password),
  'capture.clearPassword': () => capture.clearSeparatePassword(),

  'ui.secretsVisible': ({ visible }) => {
    ctx.applyScreenCapture(null, !!visible);
    return { ok: true };
  },
  'ui.titleBarColors': ({ color, symbolColor }) => {
    ctx.applyTitleBarColors({ color, symbolColor });
    return { ok: true };
  },
  'ui.error': async ({ title, message }) => {
    await dialog.showMessageBox(win(), {
      type: 'error',
      buttons: ['OK'],
      title: title || 'Propolis',
      message: message || ''
    });
    return { ok: true };
  }
};

function registerIpc(context) {
  ctx = { ...ctx, ...context };

  // Answered synchronously because the renderer needs the language before its
  // first script runs, not after a round trip. Nothing secret goes over it.
  ipcMain.removeAllListeners('propolis-language');
  ipcMain.on('propolis-language', (event) => {
    try {
      event.returnValue = settings.getPrefs().language || 'en';
    } catch {
      event.returnValue = 'en';
    }
  });

  // The extension copies through here, so the popup never holds a password and
  // the clipboard is cleared on the same timer as a copy made in the app.
  browserbridge.setCopier(copyWithTimeout);

  ipcMain.handle('propolis', async (event, method, args) => {
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
