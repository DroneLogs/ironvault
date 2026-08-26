'use strict';

/**
 * KeePass field references and placeholders.
 *
 *   {TITLE} {USERNAME} {PASSWORD} {URL} {NOTES}
 *   {S:Custom Field}
 *   {REF:P@I:1A2B3C...}   the password of the entry with that UUID
 *   {REF:U@T:GitHub}      the username of the entry titled GitHub
 *   {DT_YYYY} {DT_MM} ... date parts
 *   {URL:HOST} {URL:SCM} {URL:PATH} ... parts of the entry's own URL
 *
 * Expansion is recursive so a reference can point at a field that itself holds
 * a placeholder, with a depth limit to stop a reference loop.
 */

const MAX_DEPTH = 8;

const FIELD_BY_CODE = {
  T: 'Title',
  U: 'UserName',
  P: 'Password',
  A: 'URL',
  N: 'Notes',
  I: 'UUID',
  O: 'Other'
};

function two(value) {
  return String(value).padStart(2, '0');
}

function dateParts(now = new Date()) {
  return {
    DT_YYYY: String(now.getFullYear()),
    DT_MM: two(now.getMonth() + 1),
    DT_DD: two(now.getDate()),
    DT_HH: two(now.getHours()),
    DT_MM_TIME: two(now.getMinutes()),
    DT_SS: two(now.getSeconds()),
    DT_SIMPLE:
      String(now.getFullYear()) +
      two(now.getMonth() + 1) +
      two(now.getDate()) +
      two(now.getHours()) +
      two(now.getMinutes()) +
      two(now.getSeconds())
  };
}

function urlPart(url, part) {
  if (!url) return '';
  let parsed;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : 'https://' + url);
  } catch {
    return '';
  }
  switch (part.toUpperCase()) {
    case 'SCM':
      return parsed.protocol.replace(':', '');
    case 'HOST':
      return parsed.hostname;
    case 'PORT':
      return parsed.port;
    case 'PATH':
      return parsed.pathname;
    case 'QUERY':
      return parsed.search.replace(/^\?/, '');
    case 'USERINFO':
      return parsed.username + (parsed.password ? ':' + parsed.password : '');
    case 'USERNAME':
      return parsed.username;
    case 'PASSWORD':
      return parsed.password;
    case 'RMVSCM':
      return url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    default:
      return '';
  }
}

/**
 * `resolver` supplies the surrounding database:
 *   getField(entry, name)   -> string
 *   findByUuid(uuid)        -> entry or null
 *   findByField(code, text) -> entry or null
 */
function expand(text, entry, resolver, depth = 0) {
  const value = String(text == null ? '' : text);
  if (depth >= MAX_DEPTH || !value.includes('{')) return value;

  const dates = dateParts();

  const expanded = value.replace(/\{([^{}]+)\}/g, (whole, inner) => {
    const upper = inner.toUpperCase();

    /* references to another entry */
    const ref = /^REF:([TUPANIO])@([TUPANIO]):(.+)$/i.exec(inner);
    if (ref) {
      const wantCode = ref[1].toUpperCase();
      const searchCode = ref[2].toUpperCase();
      const needle = ref[3];
      const target =
        searchCode === 'I'
          ? resolver.findByUuid(needle)
          : resolver.findByField(FIELD_BY_CODE[searchCode], needle);
      if (!target) return whole;
      if (wantCode === 'I') return resolver.getUuid(target);
      return expand(resolver.getField(target, FIELD_BY_CODE[wantCode]), target, resolver, depth + 1);
    }

    /* a custom field on this entry */
    const custom = /^S:(.+)$/i.exec(inner);
    if (custom) {
      if (!entry) return whole;
      return expand(resolver.getField(entry, custom[1]), entry, resolver, depth + 1);
    }

    /* parts of this entry's URL */
    const urlBit = /^URL:(.+)$/i.exec(inner);
    if (urlBit) {
      if (!entry) return whole;
      return urlPart(resolver.getField(entry, 'URL'), urlBit[1]);
    }

    /* standard fields on this entry */
    const standard = {
      TITLE: 'Title',
      USERNAME: 'UserName',
      PASSWORD: 'Password',
      URL: 'URL',
      NOTES: 'Notes'
    }[upper];
    if (standard) {
      if (!entry) return whole;
      return expand(resolver.getField(entry, standard), entry, resolver, depth + 1);
    }

    if (upper === 'UUID') return entry ? resolver.getUuid(entry) : whole;
    if (upper === 'GROUP') return entry ? resolver.getGroupName(entry) : whole;

    /* dates. DT_MM means the month, so the minute needs its own name. */
    if (upper === 'DT_MM_TIME' || upper === 'DT_MIN') return dates.DT_MM_TIME;
    if (dates[upper] !== undefined) return dates[upper];

    return whole; // leave anything unrecognised exactly as written
  });

  return expanded === value ? expanded : expand(expanded, entry, resolver, depth + 1);
}

function hasPlaceholders(text) {
  return typeof text === 'string' && /\{[^{}]+\}/.test(text);
}

module.exports = { expand, hasPlaceholders, urlPart };
