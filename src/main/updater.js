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
 * A private GitHub repository answers an unauthenticated request for a release
 * asset with a 404, which reads like a broken URL. Say what it actually means.
 */
function explain(message, url) {
  const text = String(message || '');
  if (/github\.com/i.test(url) && /(404|401|403)|not found|cannot find/i.test(text)) {
    return (
      'The update feed could not be read. If the repository is still private, update ' +
      'checks cannot reach it: the app sends no credentials. Make the repository public, ' +
      'or point the feed somewhere unauthenticated.'
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
  checkedAt: 0
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
    setState({ status: 'checking', error: null });
    await updater.checkForUpdates();
  } catch (err) {
    setState({ status: 'error', error: explain(err.message, url) });
  }
  return snapshot();
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
function checkOnLaunch(send) {
  notify = send || notify;
  const prefs = settings.getPrefs();
  if (!prefs.autoCheckUpdates || !feedUrl() || !app.isPackaged) return;
  // Give the window a moment to appear before touching the network.
  setTimeout(() => {
    check({ manual: false }).catch(() => {});
  }, 8000);
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
