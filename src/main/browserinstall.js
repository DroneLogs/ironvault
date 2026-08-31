'use strict';

/**
 * Registering the native messaging host with the browsers on this machine.
 *
 * A browser will only launch a host it has been told about, and being told
 * means two things on Windows: a small JSON manifest naming the program and
 * which extensions may talk to it, and a registry value under the browser's own
 * key pointing at that manifest. Both live under HKCU, so none of this needs
 * administrator rights.
 *
 * The manifest names an extension id in allowed_origins, and only that
 * extension can reach the host. A side loaded extension gets its id from the
 * browser rather than from us, which is why setup asks for it: hard coding one
 * would only work for a Web Store build, and pretending otherwise would leave
 * people with a connection that silently never works.
 */

const fs = require('fs');
const path = require('path');
const { app, shell } = require('electron');
const { execFile } = require('child_process');

const HOST_NAME = 'com.skepwright.propolis';

/**
 * Where each browser looks. Chromium browsers share a layout; Firefox uses its
 * own key and a slightly different manifest, so it is handled separately.
 */
const BROWSERS = [
  { key: 'chrome', name: 'Chrome', registry: 'Software\\Google\\Chrome\\NativeMessagingHosts', family: 'chromium' },
  { key: 'edge', name: 'Edge', registry: 'Software\\Microsoft\\Edge\\NativeMessagingHosts', family: 'chromium' },
  { key: 'brave', name: 'Brave', registry: 'Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts', family: 'chromium' },
  { key: 'vivaldi', name: 'Vivaldi', registry: 'Software\\Vivaldi\\NativeMessagingHosts', family: 'chromium' },
  { key: 'firefox', name: 'Firefox', registry: 'Software\\Mozilla\\NativeMessagingHosts', family: 'firefox' }
];

function browsers() {
  return BROWSERS.map(({ key, name, family }) => ({ key, name, family }));
}

/** Everything this writes lives in one folder, so removing it is one delete. */
function hostDir() {
  return path.join(app.getPath('userData'), 'browser-host');
}

function launcherPath() {
  return path.join(hostDir(), 'propolis-browser-host.cmd');
}

function manifestPath(family) {
  return path.join(hostDir(), 'host-' + family + '.json');
}

/**
 * The script the browser actually launches.
 *
 * A packaged build has no node of its own, so this runs the Propolis executable
 * with ELECTRON_RUN_AS_NODE, which makes it start as a plain node and run the
 * relay instead of opening a window. Chrome passes the calling extension's
 * origin as an argument, which is ignored: the manifest has already restricted
 * who may launch this at all.
 */
function writeLauncher() {
  fs.mkdirSync(hostDir(), { recursive: true });

  const exe = app.getPath('exe');
  const script = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar', 'src', 'host', 'host.js')
    : path.join(__dirname, '..', 'host', 'host.js');

  const lines = [
    '@echo off',
    'setlocal',
    'set ELECTRON_RUN_AS_NODE=1',
    '"' + exe + '" "' + script + '"',
    'endlocal'
  ];
  const file = launcherPath();
  fs.writeFileSync(file, lines.join('\r\n') + '\r\n', 'utf8');
  return file;
}

function writeManifest(family, extensionId) {
  const base = {
    name: HOST_NAME,
    description: 'Propolis password manager',
    path: launcherPath(),
    type: 'stdio'
  };
  const manifest =
    family === 'firefox'
      ? { ...base, allowed_extensions: [extensionId] }
      : { ...base, allowed_origins: ['chrome-extension://' + extensionId + '/'] };

  const file = manifestPath(family);
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2), 'utf8');
  return file;
}

function reg(args) {
  return new Promise((resolve, reject) => {
    execFile('reg', args, { windowsHide: true, timeout: 10000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim()));
      resolve(String(stdout));
    });
  });
}

/**
 * Firefox wants a bare extension id like propolis@skepwright. Chromium wants
 * the 32 letter id the browser generated. Neither is guessable, so both are
 * checked rather than assumed, since a wrong id fails silently at connect time
 * with nothing in any log the user will find.
 */
function validateId(family, extensionId) {
  const id = String(extensionId || '').trim();
  if (family === 'firefox') {
    if (!/^[^\s@]+@[^\s@]+$/.test(id)) {
      throw new Error('A Firefox extension id looks like propolis@skepwright');
    }
    return id;
  }
  if (!/^[a-p]{32}$/.test(id)) {
    throw new Error(
      'A Chrome extension id is 32 letters from a to p. Copy it from the extension card on chrome://extensions'
    );
  }
  return id;
}

async function install({ browser: browserKey, extensionId } = {}) {
  const browser = BROWSERS.find((b) => b.key === browserKey);
  if (!browser) throw new Error('Unknown browser');
  const id = validateId(browser.family, extensionId);

  writeLauncher();
  const manifest = writeManifest(browser.family, id);
  await reg(['add', 'HKCU\\' + browser.registry + '\\' + HOST_NAME, '/ve', '/t', 'REG_SZ', '/d', manifest, '/f']);

  return { ok: true, browser: browser.key, manifest, launcher: launcherPath() };
}

async function uninstall({ browser: browserKey } = {}) {
  const browser = BROWSERS.find((b) => b.key === browserKey);
  if (!browser) throw new Error('Unknown browser');
  try {
    await reg(['delete', 'HKCU\\' + browser.registry + '\\' + HOST_NAME, '/f']);
  } catch {
    // Already absent is the state we wanted, so it is not an error.
  }
  return { ok: true, browser: browser.key };
}

/** Which browsers currently point at us, so the settings screen can say so. */
async function status() {
  const rows = [];
  for (const browser of BROWSERS) {
    let registered = false;
    try {
      const out = await reg(['query', 'HKCU\\' + browser.registry + '\\' + HOST_NAME, '/ve']);
      registered = out.includes(HOST_NAME) || out.includes('REG_SZ');
    } catch {
      registered = false;
    }
    rows.push({ key: browser.key, name: browser.name, family: browser.family, registered });
  }
  return { hostName: HOST_NAME, dir: hostDir(), extensionDir: extensionDir(), browsers: rows };
}

/**
 * Where the unpacked extension lives for the browser to load.
 *
 * Deliberately a copy under the user's own data, and not the folder the app was
 * installed into, for two reasons that both broke a real setup.
 *
 * A browser derives the id of an unpacked extension from the path it was loaded
 * from, and that id is written into the host manifest as the only extension
 * allowed to connect. So the path has to be one that never changes. Inside the
 * install folder it changes every time the app updates, because the installer
 * replaces that directory wholesale, and the browser can drop or disable the
 * extension when the files it is watching are swapped underneath it.
 *
 * And in a development checkout it would point at the working tree, where the
 * files change whenever anybody edits them, which is worse still.
 *
 * So: one stable folder beside the settings, refreshed from whatever the app
 * shipped when the app is newer. The path never moves, the id never changes,
 * and an update means at most reloading the extension rather than setting it up
 * again.
 */
function extensionDir() {
  return path.join(app.getPath('userData'), 'extension');
}

/** The copy that came with this build, which the stable folder is filled from. */
function packagedExtensionDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'extension')
    : path.join(__dirname, '..', '..', 'extension');
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(source, target);
    else fs.copyFileSync(source, target);
  }
}

/**
 * Refreshes the stable copy when the shipped one is newer.
 *
 * Compared by the version in the manifest rather than by timestamps, because a
 * reinstall can leave file dates that say nothing useful. Failing here must not
 * stop the app starting: an extension that is one version behind still works,
 * and a browser that cannot connect is a smaller problem than a vault that will
 * not open.
 */
function syncExtension() {
  const from = packagedExtensionDir();
  const to = extensionDir();
  try {
    if (!fs.existsSync(from)) return { ok: false, reason: 'nothing shipped' };

    const readVersion = (dir) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).version || '0';
      } catch {
        return null;
      }
    };
    const shipped = readVersion(from);
    const installed = readVersion(to);

    if (installed && shipped === installed) return { ok: true, dir: to, copied: false };

    copyDir(from, to);
    return { ok: true, dir: to, copied: true, version: shipped };
  } catch (err) {
    console.error('Could not put the browser extension in place: ' + err.message);
    return { ok: false, reason: err.message };
  }
}

function revealExtension() {
  syncExtension();
  const dir = extensionDir();
  if (!fs.existsSync(dir)) throw new Error('The extension folder could not be prepared');
  shell.openPath(dir);
  return { ok: true, dir };
}

module.exports = {
  install,
  syncExtension,
  packagedExtensionDir,
  uninstall,
  status,
  browsers,
  extensionDir,
  revealExtension,
  HOST_NAME,
  hostDir,
  launcherPath
};
