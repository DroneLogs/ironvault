'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

/**
 * Favicon downloader. Fetches a site's icon so an entry can carry the real
 * logo instead of a coloured initial.
 *
 * This is the only part of the app besides update checks and the Have I Been
 * Pwned audit that touches the network, it only runs when you ask it to, and it
 * sends nothing but the request for the icon.
 */

const MAX_BYTES = 128 * 1024;
const TIMEOUT_MS = 12000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Ironvault/1.0';

function get(target, { redirects = 0, maxBytes = MAX_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    if (redirects > 4) return reject(new Error('Too many redirects'));

    let url;
    try {
      url = new URL(target);
    } catch {
      return reject(new Error('Bad URL: ' + target));
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return reject(new Error('Only http and https are supported'));
    }

    const client = url.protocol === 'https:' ? https : http;
    const request = client.get(
      url,
      { headers: { 'User-Agent': USER_AGENT, Accept: '*/*' }, timeout: TIMEOUT_MS },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(get(new URL(res.headers.location, url).toString(), { redirects: redirects + 1, maxBytes }));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode));
        }

        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            request.destroy();
            return reject(new Error('That icon is larger than ' + Math.round(maxBytes / 1024) + ' KB'));
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          resolve({ body: Buffer.concat(chunks), contentType: String(res.headers['content-type'] || ''), url: url.toString() })
        );
      }
    );
    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy();
      reject(new Error('Timed out'));
    });
  });
}

/** png, jpeg, gif, x-icon, svg. Anything else is not usable as an icon. */
function sniff(buffer, contentType) {
  if (buffer.length < 4) return null;
  if (buffer[0] === 0x89 && buffer.toString('ascii', 1, 4) === 'PNG') return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
  if (buffer.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  if (buffer.readUInt32LE(0) === 0x00010000) return 'image/x-icon';
  const head = buffer.toString('utf8', 0, Math.min(300, buffer.length)).trimStart();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  if (/^image\/(png|jpeg|gif|svg\+xml|x-icon|vnd\.microsoft\.icon|webp)/i.test(contentType)) {
    return contentType.split(';')[0].trim().toLowerCase();
  }
  return null;
}

/** Pulls icon links out of the page head without a full HTML parser. */
function iconLinksFrom(html, baseUrl) {
  const found = [];
  const linkTag = /<link\b[^>]*>/gi;
  let match;
  while ((match = linkTag.exec(html)) !== null) {
    const tag = match[0];
    const rel = /rel\s*=\s*["']?([^"'>]+)/i.exec(tag);
    if (!rel || !/\b(shortcut\s+)?icon\b|apple-touch-icon/i.test(rel[1])) continue;
    const href = /href\s*=\s*["']([^"']+)/i.exec(tag);
    if (!href) continue;
    const sizes = /sizes\s*=\s*["']?(\d+)/i.exec(tag);
    try {
      found.push({
        url: new URL(href[1], baseUrl).toString(),
        size: sizes ? parseInt(sizes[1], 10) : /apple-touch-icon/i.test(rel[1]) ? 180 : 0
      });
    } catch {
      /* skip anything that will not resolve */
    }
  }
  return found;
}

/**
 * Tries the page's declared icons, best size first, then the conventional
 * /favicon.ico. Returns a data URL ready to become a KDBX custom icon.
 */
async function fetchFavicon(rawUrl) {
  const site = /^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl) ? rawUrl : 'https://' + rawUrl;
  let base;
  try {
    base = new URL(site);
  } catch {
    throw new Error('That entry has no usable URL');
  }

  const candidates = [];
  try {
    const page = await get(base.origin + base.pathname, { maxBytes: 512 * 1024 });
    const html = page.body.toString('utf8');
    // Prefer something around 64px: big enough to look sharp, small to store.
    const links = iconLinksFrom(html, page.url).sort((a, b) => {
      const score = (s) => (s.size === 0 ? 32 : Math.abs(s.size - 64));
      return score(a) - score(b);
    });
    candidates.push(...links.map((l) => l.url));
  } catch {
    /* the page itself may be unreachable while the icon is not */
  }

  candidates.push(base.origin + '/favicon.ico');

  const tried = new Set();
  const failures = [];
  for (const candidate of candidates) {
    if (tried.has(candidate)) continue;
    tried.add(candidate);
    try {
      const result = await get(candidate);
      const mime = sniff(result.body, result.contentType);
      if (!mime) {
        failures.push(candidate + ': not an image');
        continue;
      }
      return {
        dataUrl: 'data:' + mime + ';base64,' + result.body.toString('base64'),
        base64: result.body.toString('base64'),
        mime,
        bytes: result.body.length,
        source: candidate
      };
    } catch (err) {
      failures.push(candidate + ': ' + err.message);
    }
  }

  const error = new Error('No icon found for ' + base.hostname);
  error.detail = failures.join('; ');
  throw error;
}

module.exports = { fetchFavicon, sniff, iconLinksFrom };
