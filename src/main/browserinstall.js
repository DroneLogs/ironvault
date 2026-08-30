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
 * Where the unpacked extension sits, which is what the browser has to be
 * pointed at. It ships beside the app rather than inside app.asar, because a
 * browser cannot load an extension out of an archive.
 */
function extensionDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'extension')
    : path.join(__dirname, '..', '..', 'extension');
}

function revealExtension() {
  const dir = extensionDir();
  if (!fs.existsSync(dir)) throw new Error('The extension folder is missing from this install');
  shell.openPath(dir);
  return { ok: true, dir };
}

module.exports = {
  install,
  uninstall,
  status,
  browsers,
  extensionDir,
  revealExtension,
  HOST_NAME,
  hostDir,
  launcherPath
};
