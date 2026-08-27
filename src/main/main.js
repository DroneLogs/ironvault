'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, Menu, shell, powerMonitor, nativeTheme, globalShortcut } = require('electron');

const { registerArgon2 } = require('./argon2');
const settings = require('./settings');
const vault = require('./vault');
const { registerIpc, clearClipboardNow } = require('./ipc');
const updater = require('./updater');
const features = require('./features');
const sshagent = require('./sshagent');
const brand = require('./brand');

registerArgon2();

/**
 * The app was called Ironvault until the rename, and Electron derives the
 * profile directory from the product name, so everything written before the
 * rename sits in the Ironvault folder under %APPDATA%. Carry it across once, on
 * the first start that finds no settings of its own.
 *
 * SETTINGS AND BACKUPS ONLY. The rest of that directory is Chromium cache,
 * which an older build still running holds locks on, and copying the whole
 * thing fails part way through on a locked file. These two are everything the
 * app itself writes. The originals are left in place, so an older build still
 * opens as it always did.
 *
 * The test is settings.json rather than the directory, because Chromium has
 * usually created the directory and filled it before this runs.
 */
function adoptPreviousProfile() {
  const target = app.getPath('userData');
  const previous = path.join(app.getPath('appData'), 'Ironvault');
  try {
    // A harness running against a throwaway profile must not inherit real
    // databases, so only the default profile location ever adopts anything.
    const standard = path.join(app.getPath('appData'), app.getName());
    if (path.resolve(target) !== path.resolve(standard)) return;
    if (fs.existsSync(path.join(target, 'settings.json'))) return;
    if (!fs.existsSync(path.join(previous, 'settings.json'))) return;
    fs.mkdirSync(target, { recursive: true });
    fs.copyFileSync(path.join(previous, 'settings.json'), path.join(target, 'settings.json'));
    console.log('Carried the Ironvault settings over to ' + target);
  } catch (err) {
    console.error('Could not carry the previous settings over: ' + err.message);
    return;
  }
  try {
    const backups = path.join(previous, 'backups');
    if (fs.existsSync(backups)) fs.cpSync(backups, path.join(target, 'backups'), { recursive: true, force: false, errorOnExist: false });
  } catch (err) {
    console.error('Could not carry the previous backups over: ' + err.message);
  }
}

adoptPreviousProfile();

const isDev = process.argv.includes('--dev');
const APP_ICON = path.join(__dirname, '..', '..', 'build', 'icon.ico');

/** The alternate window icons offered in Settings. */
function iconPathFor(name) {
  if (!name || name === 'default') return APP_ICON;
  const candidate = path.join(__dirname, '..', '..', 'build', 'icon-' + name + '.ico');
  return fs.existsSync(candidate) ? candidate : APP_ICON;
}

/** Window zoom is how text scaling is done: it grows layout as well as glyphs. */
function applyZoom(factor) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const clamped = Math.max(0.8, Math.min(2.5, Number(factor) || 1));
  try {
    mainWindow.webContents.setZoomFactor(clamped);
  } catch (err) {
    console.error('Could not set the zoom factor: ' + err.message);
  }
}

function applyAppIcon(themeKey) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.setIcon(iconPathFor(brand.iconKeyFor(themeKey)));
    mainWindow.setTitle(brand.productNameFor(themeKey));
  } catch (err) {
    console.error('Could not set the window icon: ' + err.message);
  }
}

/**
 * Windows caches the taskbar icon against the running instance, so a live
 * setIcon does not always reach it. Relaunching is the reliable way to make the
 * change take everywhere at once.
 */
function relaunch() {
  app.relaunch();
  app.exit(0);
}
let mainWindow = null;
let idleTimer = null;
let pendingFile = null;

/**
 * Windows hands a double clicked .kdbx to the app as a command line argument,
 * both on first launch and, through second-instance, while it is already open.
 */
function kdbxFromArgv(argv) {
  for (const arg of (argv || []).slice(1)) {
    if (/\.kdbx?$/i.test(arg)) {
      try {
        if (fs.existsSync(arg)) return path.resolve(arg);
      } catch {
        /* ignore an unreadable argument */
      }
    }
  }
  return null;
}

pendingFile = kdbxFromArgv(process.argv);

/**
 * Custom URL handling. `propolis://open?db=<path>` picks a database on the
 * unlock screen, and `propolis://search?q=<text>` jumps straight to a search.
 * Only these two verbs are honoured, and neither can unlock anything.
 *
 * `ironvault://` is the name the app shipped under before the rename, and it
 * still works, so links written against the old build do not quietly do nothing.
 */
const URL_SCHEMES = ['propolis', 'ironvault'];

function propolisUrlFromArgv(argv) {
  for (const arg of (argv || []).slice(1)) {
    if (/^(propolis|ironvault):\/\//i.test(arg)) return arg;
  }
  return null;
}

let pendingUrl = propolisUrlFromArgv(process.argv);

function handlePropolisUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return;
  }
  const action = (parsed.hostname || parsed.pathname.replace(/^\/+/, '')).toLowerCase();
  const params = parsed.searchParams;
  if (action === 'open') {
    const db = params.get('db');
    if (db) send('open-file', { filePath: db });
  } else if (action === 'search') {
    send('menu', 'app:search');
    const query = params.get('q');
    if (query) send('url-search', { query });
  }
}

/* ------------------------------------------------------------------ window */

function createWindow() {
  const bounds = settings.getWindowBounds();
  mainWindow = new BrowserWindow({
    width: bounds.width || 1180,
    height: bounds.height || 760,
    minWidth: 900,
    minHeight: 600,
    show: false,
    icon: fs.existsSync(iconPathFor(brand.iconKeyFor(settings.getPrefs().theme)))
      ? iconPathFor(brand.iconKeyFor(settings.getPrefs().theme))
      : undefined,
    backgroundColor: '#12141a',
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#12141a',
      symbolColor: '#c9cede',
      height: 40
    },
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: isDev
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // ready-to-show does not fire reliably for a window created hidden, so treat
  // the first paint, the finished load, and a short timeout as equal triggers.
  let shown = false;
  const reveal = () => {
    if (shown || !mainWindow || mainWindow.isDestroyed()) return;
    shown = true;
    clearTimeout(revealTimer);
    mainWindow.show();
  };
  mainWindow.webContents.on('did-finish-load', () => applyZoom(settings.getPrefs().zoom));

  const revealTimer = setTimeout(reveal, 2500);
  mainWindow.once('ready-to-show', reveal);
  mainWindow.webContents.once('did-finish-load', reveal);

  mainWindow.webContents.on('did-fail-load', (_e, code, description, url) => {
    console.error('Failed to load ' + url + ': ' + description + ' (' + code + ')');
    reveal();
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('Renderer gone: ' + details.reason + ' exit=' + details.exitCode);
  });
  mainWindow.webContents.on('preload-error', (_e, preloadPath, error) => {
    console.error('Preload failed at ' + preloadPath + ': ' + error.message);
  });

  mainWindow.on('resize', saveBounds);
  mainWindow.on('close', () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    if (!mainWindow.isDestroyed() && !mainWindow.isMinimized()) {
      const [width, height] = mainWindow.getSize();
      settings.setWindowBounds({ width, height });
    }
    clearClipboardNow();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.on('minimize', () => {
    if (settings.getPrefs().lockOnMinimize) lockNow('window minimized');
  });

  // Anything that is not the app's own page belongs in the user's browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
}

let boundsTimer = null;

function saveBounds() {
  // resize fires continuously while dragging, so write the file once it settles.
  if (boundsTimer) clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
    const [width, height] = mainWindow.getSize();
    settings.setWindowBounds({ width, height });
  }, 400);
}

/* -------------------------------------------------------------- auto lock */

function lockNow(reason) {
  if (!vault.isOpen()) return;
  vault.lock();
  clearClipboardNow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('vault:locked', { reason });
  }
}

/**
 * Auto-type runs from a global hotkey, so the window Propolis types into is
 * whatever the user was already looking at. The window is never focused here.
 */
async function runAutoType() {
  if (!vault.isOpen()) {
    send('autotype-result', { ok: false, error: 'Unlock a database first' });
    return;
  }
  try {
    const result = await features.autoTypeNow({});
    send('autotype-result', { ok: true, ...result });
  } catch (err) {
    send('autotype-result', { ok: false, error: err.message, code: err.code || null });
  }
}

function registerHotkeys() {
  globalShortcut.unregisterAll();
  const prefs = settings.getPrefs();
  if (prefs.autoTypeHotkey) {
    try {
      globalShortcut.register(prefs.autoTypeHotkey, runAutoType);
    } catch (err) {
      console.error('Could not register the auto-type hotkey: ' + err.message);
    }
  }
}

function startIdleWatch() {
  if (idleTimer) clearInterval(idleTimer);
  idleTimer = setInterval(() => {
    const minutes = Number(settings.getPrefs().autoLockMinutes) || 0;
    if (!minutes || !vault.isOpen()) return;
    // getSystemIdleTime covers the whole desktop, so leaving the machine locks
    // the vault even if the app itself was never focused.
    if (powerMonitor.getSystemIdleTime() >= minutes * 60) {
      lockNow('idle');
    }
  }, 5000);
}

/* ------------------------------------------------------------------- menu */

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'New Database...', accelerator: 'CmdOrCtrl+Shift+N', click: () => send('menu', 'database:new') },
        { label: 'Open Database...', accelerator: 'CmdOrCtrl+O', click: () => send('menu', 'database:open') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => send('menu', 'database:save') },
        { label: 'Lock', accelerator: 'CmdOrCtrl+L', click: () => send('menu', 'database:lock') },
        { type: 'separator' },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => send('menu', 'app:settings') },
        { type: 'separator' },
        { role: 'quit', label: 'Exit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'New Entry', accelerator: 'CmdOrCtrl+N', click: () => send('menu', 'entry:new') },
        { label: 'New Group', accelerator: 'CmdOrCtrl+G', click: () => send('menu', 'group:new') },
        { type: 'separator' },
        { label: 'Copy Username', accelerator: 'CmdOrCtrl+B', click: () => send('menu', 'entry:copyUsername') },
        { label: 'Copy Password', accelerator: 'CmdOrCtrl+Shift+C', click: () => send('menu', 'entry:copyPassword') },
        { label: 'Copy One Time Code', accelerator: 'CmdOrCtrl+T', click: () => send('menu', 'entry:copyTotp') },
        { label: 'Open URL', accelerator: 'CmdOrCtrl+Shift+U', click: () => send('menu', 'entry:openUrl') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'Tools',
      submenu: [
        { label: 'Compare Databases...', click: () => send('menu', 'tools:compare') },
        { label: 'Sync Now', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('menu', 'tools:sync') },
        { type: 'separator' },
        { label: 'Import...', click: () => send('menu', 'tools:import') },
        { label: 'Export...', click: () => send('menu', 'tools:export') },
        { type: 'separator' },
        { label: 'Have I Been Pwned Audit', click: () => send('menu', 'tools:pwned') },
        { label: 'Find Similar Passwords', click: () => send('menu', 'tools:similar') },
        { label: 'Download All Favicons', click: () => send('menu', 'tools:favicons') },
        { type: 'separator' },
        { label: 'Auto-Type Now', accelerator: 'CmdOrCtrl+Shift+T', click: () => runAutoType() },
        { label: 'SSH Agent...', click: () => send('menu', 'tools:ssh') },
        { type: 'separator' },
        { label: 'Backups...', click: () => send('menu', 'tools:backups') },
        { label: 'Security & Unlock...', click: () => send('menu', 'tools:security') },
        { label: 'Remote Storage...', click: () => send('menu', 'tools:remote') }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Search', accelerator: 'CmdOrCtrl+F', click: () => send('menu', 'app:search') },
        { label: 'Password Generator', accelerator: 'CmdOrCtrl+P', click: () => send('menu', 'app:generator') },
        { label: 'Security Audit', accelerator: 'CmdOrCtrl+Shift+A', click: () => send('menu', 'app:audit') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(isDev ? [{ role: 'toggleDevTools' }] : [])
      ]
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Keyboard Shortcuts', click: () => send('menu', 'app:shortcuts') },
        { label: 'Check for Updates...', click: () => send('menu', 'app:updates') },
        { type: 'separator' },
        { label: 'About Propolis', click: () => send('menu', 'app:about') }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* -------------------------------------------------------------- lifecycle */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const url = propolisUrlFromArgv(argv);
    if (url) {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
        handlePropolisUrl(url);
      } else {
        pendingUrl = url;
      }
      return;
    }
    const file = kdbxFromArgv(argv);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      if (file) mainWindow.webContents.send('open-file', { filePath: file });
    } else if (file) {
      pendingFile = file;
    }
  });

  app.whenReady().then(() => {
    nativeTheme.themeSource = 'dark';

    // Register propolis:// so links can point at a database or a search.
    for (const scheme of URL_SCHEMES) {
      try {
        if (app.isPackaged) app.setAsDefaultProtocolClient(scheme);
        else app.setAsDefaultProtocolClient(scheme, process.execPath, [path.resolve(process.argv[1] || '.')]);
      } catch (err) {
        console.error('Could not register the ' + scheme + ':// handler: ' + err.message);
      }
    }
    registerIpc({
      getWindow: () => mainWindow,
      lockNow,
      applyAppIcon,
      applyZoom,
      relaunch,
      registerHotkeys,
      takePendingFile: () => {
        const file = pendingFile;
        pendingFile = null;
        return file;
      }
    });
    updater.setNotifier((state) => send('update-state', state));
    buildMenu();
    createWindow();
    startIdleWatch();
    registerHotkeys();
    updater.checkOnLaunch((state) => send('update-state', state));

    if (pendingUrl) {
      const url = pendingUrl;
      pendingUrl = null;
      setTimeout(() => handlePropolisUrl(url), 2500);
    }

    powerMonitor.on('suspend', () => {
      if (settings.getPrefs().lockOnSuspend) lockNow('system suspended');
    });
    powerMonitor.on('lock-screen', () => {
      if (settings.getPrefs().lockOnSuspend) lockNow('screen locked');
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    clearClipboardNow();
    app.quit();
  });

  app.on('before-quit', () => {
    globalShortcut.unregisterAll();
    try {
      sshagent.stop();
    } catch {
      /* nothing listening */
    }
    vault.lock();
    clearClipboardNow();
  });
}
