'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { safeStorage } = require('electron');

const settings = require('./settings');

/**
 * Remote storage for a database: WebDAV (which covers Nextcloud, ownCloud, and
 * most NAS boxes) and SFTP.
 *
 * A remote database is still a local file. Ironvault opens the local copy, and
 * syncing pulls the remote version, merges the two, and pushes the result back.
 * That is what makes offline editing work: with no connection you keep editing
 * the local copy, and the merge happens on the next successful sync.
 */

const TIMEOUT_MS = 30000;

/* ------------------------------------------------------------- credentials */

function sealSecret(text) {
  if (!text) return null;
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return { dpapi: true, data: safeStorage.encryptString(String(text)).toString('base64') };
    }
  } catch {
    /* fall through to the plain form below */
  }
  return { dpapi: false, data: Buffer.from(String(text), 'utf8').toString('base64') };
}

function openSecret(record) {
  if (!record) return '';
  try {
    if (record.dpapi) return safeStorage.decryptString(Buffer.from(record.data, 'base64'));
    return Buffer.from(record.data, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function getConfig(dbPath) {
  const secrets = settings.getSecrets(dbPath);
  return secrets.remote || null;
}

function setConfig(dbPath, config) {
  if (!config) {
    settings.setSecrets(dbPath, { remote: null });
    return null;
  }
  const stored = { ...config };
  if (config.password !== undefined) {
    stored.password = config.password ? sealSecret(config.password) : null;
  }
  if (config.passphrase !== undefined) {
    stored.passphrase = config.passphrase ? sealSecret(config.passphrase) : null;
  }
  settings.setSecrets(dbPath, { remote: stored });
  return describe(stored);
}

/** What the renderer is allowed to see: never the stored secrets. */
function describe(config) {
  if (!config) return null;
  return {
    provider: config.provider,
    url: config.url || '',
    host: config.host || '',
    port: config.port || (config.provider === 'sftp' ? 22 : undefined),
    username: config.username || '',
    remotePath: config.remotePath || '',
    privateKeyPath: config.privateKeyPath || '',
    hasPassword: Boolean(config.password),
    hasPassphrase: Boolean(config.passphrase),
    lastSyncedAt: config.lastSyncedAt || 0,
    lastError: config.lastError || ''
  };
}

/* ------------------------------------------------------------------ WebDAV */

function webdavRequest(config, method, { body, headers = {}, expect = [200, 201, 204, 207] } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(config.url);
    } catch {
      return reject(new Error('The WebDAV URL is not valid'));
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return reject(new Error('WebDAV needs an http or https URL'));
    }

    const client = url.protocol === 'https:' ? https : http;
    const auth = config.username
      ? 'Basic ' + Buffer.from(config.username + ':' + openSecret(config.password)).toString('base64')
      : undefined;

    const request = client.request(
      url,
      {
        method,
        timeout: TIMEOUT_MS,
        headers: {
          'User-Agent': 'Ironvault',
          ...(auth ? { Authorization: auth } : {}),
          ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
          ...headers
        }
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const payload = Buffer.concat(chunks);
          if (!expect.includes(res.statusCode)) {
            const err = new Error('WebDAV returned HTTP ' + res.statusCode);
            err.statusCode = res.statusCode;
            return reject(err);
          }
          resolve({ status: res.statusCode, headers: res.headers, body: payload });
        });
      }
    );
    request.on('error', (err) => reject(new Error('WebDAV: ' + err.message)));
    request.on('timeout', () => {
      request.destroy();
      reject(new Error('WebDAV timed out'));
    });
    if (body) request.write(body);
    request.end();
  });
}

async function webdavDownload(config) {
  const result = await webdavRequest(config, 'GET', { expect: [200] });
  return result.body;
}

async function webdavUpload(config, buffer) {
  await webdavRequest(config, 'PUT', {
    body: buffer,
    headers: { 'Content-Type': 'application/octet-stream' },
    expect: [200, 201, 204]
  });
  return { ok: true };
}

async function webdavStat(config) {
  try {
    const result = await webdavRequest(config, 'HEAD', { expect: [200, 204] });
    return {
      size: Number(result.headers['content-length'] || 0),
      modified: result.headers['last-modified'] ? Date.parse(result.headers['last-modified']) : 0
    };
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

/* -------------------------------------------------------------------- SFTP */

function withSftp(config, work) {
  return new Promise((resolve, reject) => {
    let Client;
    try {
      Client = require('ssh2').Client;
    } catch {
      return reject(new Error('SFTP support is unavailable in this build'));
    }

    const connection = new Client();
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      try {
        connection.end();
      } catch {
        /* already gone */
      }
      if (err) reject(err);
      else resolve(value);
    };

    connection.on('ready', () => {
      connection.sftp((err, sftp) => {
        if (err) return finish(new Error('SFTP: ' + err.message));
        Promise.resolve()
          .then(() => work(sftp))
          .then((value) => finish(null, value))
          .catch((workErr) => finish(workErr));
      });
    });
    connection.on('error', (err) => finish(new Error('SFTP: ' + err.message)));
    connection.on('timeout', () => finish(new Error('SFTP timed out')));

    const options = {
      host: config.host,
      port: Number(config.port) || 22,
      username: config.username,
      readyTimeout: TIMEOUT_MS,
      keepaliveInterval: 10000
    };

    if (config.privateKeyPath) {
      try {
        options.privateKey = fs.readFileSync(config.privateKeyPath);
      } catch (err) {
        return finish(new Error('Could not read the private key: ' + err.message));
      }
      const passphrase = openSecret(config.passphrase);
      if (passphrase) options.passphrase = passphrase;
    } else {
      options.password = openSecret(config.password);
    }

    try {
      connection.connect(options);
    } catch (err) {
      finish(new Error('SFTP: ' + err.message));
    }
  });
}

function sftpDownload(config) {
  return withSftp(
    config,
    (sftp) =>
      new Promise((resolve, reject) => {
        sftp.readFile(config.remotePath, (err, data) => (err ? reject(new Error('SFTP: ' + err.message)) : resolve(data)));
      })
  );
}

function sftpUpload(config, buffer) {
  return withSftp(
    config,
    (sftp) =>
      new Promise((resolve, reject) => {
        sftp.writeFile(config.remotePath, buffer, (err) =>
          err ? reject(new Error('SFTP: ' + err.message)) : resolve({ ok: true })
        );
      })
  );
}

function sftpStat(config) {
  return withSftp(
    config,
    (sftp) =>
      new Promise((resolve) => {
        sftp.stat(config.remotePath, (err, stats) => {
          if (err) return resolve(null);
          resolve({ size: stats.size, modified: stats.mtime * 1000 });
        });
      })
  );
}

/* ------------------------------------------------------------- public face */

function providerOf(config) {
  if (!config || !config.provider) throw new Error('No remote storage is set up for this database');
  if (config.provider === 'webdav') return { download: webdavDownload, upload: webdavUpload, stat: webdavStat };
  if (config.provider === 'sftp') return { download: sftpDownload, upload: sftpUpload, stat: sftpStat };
  throw new Error('Unknown remote provider: ' + config.provider);
}

async function download(dbPath) {
  const config = getConfig(dbPath);
  return providerOf(config).download(config);
}

async function upload(dbPath, buffer) {
  const config = getConfig(dbPath);
  return providerOf(config).upload(config, buffer);
}

async function stat(dbPath) {
  const config = getConfig(dbPath);
  return providerOf(config).stat(config);
}

/** Used by the setup dialog, with a config that is not saved yet. */
async function test(config) {
  const draft = { ...config };
  if (config.password) draft.password = sealSecret(config.password);
  if (config.passphrase) draft.passphrase = sealSecret(config.passphrase);
  const info = await providerOf(draft).stat(draft);
  return {
    ok: true,
    exists: Boolean(info),
    size: info ? info.size : 0,
    modified: info ? info.modified : 0
  };
}

function recordSync(dbPath, { error } = {}) {
  const config = getConfig(dbPath);
  if (!config) return;
  settings.setSecrets(dbPath, {
    remote: { ...config, lastSyncedAt: error ? config.lastSyncedAt || 0 : Date.now(), lastError: error || '' }
  });
}

module.exports = {
  getConfig,
  setConfig,
  describe,
  download,
  upload,
  stat,
  test,
  recordSync,
  sealSecret,
  openSecret
};
