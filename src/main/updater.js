'use strict';

const { app, shell } = require('electron');
const settings = require('./settings');

/**
 * Update checking, the way KeePass does it on Windows: the app asks a feed
 * whether a newer build exists, tells you what changed, and can download and
 * install it for you.
 *
 * The feed URL is a setting rather than something baked in, so the same build
 * can point at GitHub Releases, a web server, or nothing at all. With no URL
 * configured nothing ever reaches the network.
 */

let autoUpdater = null;
let wired = false;

const DEFAULT_FEED = 'https://github.com/DroneLogs/ironvault/releases/latest/download/';

/**
 * A feed that is not there answers with a 404, which reads like a broken URL.
 * There are three reasons for it and nothing here can tell them apart, so all
 * three are named rather than one being asserted.
 *
 * This used to claim the repository must be private. It sent a real diagnosis
 * down the wrong path: the repository was public and the release was simply
 * missing the latest.yml that a check actually asks for.
 */
function explain(message, url) {
  const text = String(message || '');
  if (/github\.com/i.test(url) && /(404|401|403)|not found|cannot find/i.test(text)) {
    return (
      'The update feed could not be read. Either the newest release has no latest.yml ' +
      'attached, which is the file a check actually asks for, or there is no release yet, ' +
      'or the repository is private, since the app sends no credentials. Opening the feed ' +
      'URL in a browser tells you which.'
    );
  }
  return text;
}

const current = {
  status: 'idle', // idle | checking | available | none | downloading | ready | error | unconfigured
  version: null,
  notes: null,
  releaseDate: null,
  percent: 0,
  error: null,
  checkedAt: 0,
  // Whether the check that produced this state ran on its own. The window
  // only interrupts the user for one that did.
  automatic: false
};

let notify = () => {};

function feedUrl() {
  return String(settings.getPrefs().updateFeedUrl || '').trim();
}

function setState(patch) {
  Object.assign(current, patch);
  notify({ ...current, currentVersion: app.getVersion(), feedUrl: feedUrl() });
}

function loadUpdater() {
  if (autoUpdater) return autoUpdater;
  // Required lazily: pulling it in at startup costs time for a feature most
  // launches never use.
  autoUpdater = require('electron-updater').autoUpdater;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  // The builds are not code signed, so there is no publisher name to match.
  autoUpdater.verifyUpdateCodeSignature = false;
  autoUpdater.logger = {
    info: () => {},
    warn: (m) => console.warn('updater: ' + m),
    error: (m) => console.error('updater: ' + m),
    debug: () => {}
  };
  return autoUpdater;
}

function wire() {
  if (wired) return;
  const updater = loadUpdater();
  wired = true;

  updater.on('update-available', (info) => {
    setState({
      status: 'available',
      version: info.version,
      notes: typeof info.releaseNotes === 'string' ? info.releaseNotes : null,
      releaseDate: info.releaseDate || null,
      error: null
    });
  });
  updater.on('update-not-available', () => {
    setState({ status: 'none', version: null, error: null, checkedAt: Date.now() });
  });
  updater.on('download-progress', (progress) => {
    setState({ status: 'downloading', percent: Math.round(progress.percent) });
  });
  updater.on('update-downloaded', (info) => {
    setState({ status: 'ready', version: info.version, percent: 100 });
  });
  updater.on('error', (err) => {
    setState({ status: 'error', error: explain(err && err.message, feedUrl()) || 'Update check failed' });
  });
}

async function check({ manual = true } = {}) {
  const url = feedUrl();
  if (!url) {
    setState({
      status: 'unconfigured',
      error: null,
      checkedAt: Date.now()
    });
    return snapshot();
  }

  if (!app.isPackaged && manual) {
    setState({ status: 'error', error: 'Updates only work in an installed build, not from source.' });
    return snapshot();
  }

  try {
    wire();
    const updater = loadUpdater();
    updater.setFeedURL({ provider: 'generic', url: url.endsWith('/') ? url : url + '/' });
    setState({ status: 'checking', error: null, automatic: !manual });
    await updater.checkForUpdates();
    await settled();
  } catch (err) {
    setState({ status: 'error', error: explain(err.message, url) });
  }
  return snapshot();
}

/**
 * checkForUpdates resolves before the events it triggers have run, so the
 * snapshot taken straight after it still said "checking". The window did not
 * notice, because the real state arrives separately through the notifier, but
 * anything using the returned value got a state that was already stale.
 *
 * Waits for the events to land, and gives up rather than hanging if they never
 * do, since a caller waiting forever is worse than one told nothing happened.
 */
function settled({ timeoutMs = 20000 } = {}) {
  if (current.status !== 'checking') return Promise.resolve();
  return new Promise((resolve) => {
    const started = Date.now();
    const poll = setInterval(() => {
      if (current.status !== 'checking' || Date.now() - started > timeoutMs) {
        clearInterval(poll);
        resolve();
      }
    }, 50);
    if (poll.unref) poll.unref();
  });
}

async function download() {
  if (current.status !== 'available') throw new Error('There is no update ready to download');
  wire();
  setState({ status: 'downloading', percent: 0 });
  try {
    await loadUpdater().downloadUpdate();
  } catch (err) {
    setState({ status: 'error', error: err.message });
    throw err;
  }
  return snapshot();
}

function installNow() {
  if (current.status !== 'ready') throw new Error('The update has not finished downloading');
  // false, true: do not force a silent install, do run the app afterwards.
  setImmediate(() => loadUpdater().quitAndInstall(false, true));
  return { ok: true };
}

function openReleasePage() {
  const url = String(settings.getPrefs().updateReleasePageUrl || '').trim();
  if (!url) throw new Error('No release page has been set in Settings');
  if (!/^https?:\/\//i.test(url)) throw new Error('The release page must be an http or https address');
  shell.openExternal(url);
  return { ok: true };
}

function snapshot() {
  return {
    ...current,
    currentVersion: app.getVersion(),
    feedUrl: feedUrl(),
    defaultFeedUrl: DEFAULT_FEED,
    usingDefaultFeed: feedUrl() === DEFAULT_FEED
  };
}

function state() {
  if (!feedUrl() && current.status === 'idle') current.status = 'unconfigured';
  return snapshot();
}

/** Called once at startup; quiet unless something is actually available. */
const LAUNCH_DELAY_MS = 8000;
const RECHECK_MS = 24 * 60 * 60 * 1000;
let recheckTimer = null;

function checkOnLaunch(send) {
  notify = send || notify;
  const prefs = settings.getPrefs();
  if (!prefs.autoCheckUpdates || !feedUrl() || !app.isPackaged) return;

  // Give the window a moment to appear before touching the network.
  setTimeout(() => {
    check({ manual: false }).catch(() => {});
  }, LAUNCH_DELAY_MS);

  // A password manager is left open for weeks at a time, so checking only at
  // launch means somebody who never quits is never told. Once a day after that.
  if (recheckTimer) clearInterval(recheckTimer);
  recheckTimer = setInterval(() => {
    if (!settings.getPrefs().autoCheckUpdates) return;
    check({ manual: false }).catch(() => {});
  }, RECHECK_MS);
  if (recheckTimer.unref) recheckTimer.unref();
}

function setNotifier(send) {
  notify = send || notify;
}

module.exports = {
  DEFAULT_FEED,
  check,
  download,
  installNow,
  openReleasePage,
  state,
  checkOnLaunch,
  setNotifier
};
