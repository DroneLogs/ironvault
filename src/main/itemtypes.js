'use strict';

/**
 * Item types.
 *
 * KDBX has no notion of a type. Every entry is a title, a username, a password,
 * a URL, notes, and any number of custom fields, and that is the whole model.
 * A type here is a convention laid on top, and it has to stay a convention: the
 * marker is one custom field, and everything else is an ordinary field with an
 * ordinary name. A card opened in KeePassXC is then an entry with sensible
 * fields rather than something broken, which is the whole point.
 *
 * Where a type has an obvious equivalent among the built in fields it uses them
 * rather than inventing a custom one. A card number goes in Password, so it is
 * protected at rest, concealed on screen, copied by the existing button, and
 * kept in history, all without a line of new code. Only what has no built in
 * home becomes a custom field.
 */

/** The marker. Prefixed like KeePassXC's KPEX_ fields, for the same reason. */
const TYPE_FIELD = 'PROPOLIS_TYPE';

/**
 * Icons are indexes into the standard KeePass set, which every client draws
 * from, so the choice survives leaving this app.
 */
const TYPES = {
  login: {
    key: 'login',
    name: 'Login',
    hint: 'Something you sign in to.',
    icon: 0,
    labels: {},
    hide: [],
    fields: []
  },
  password: {
    key: 'password',
    name: 'Password',
    hint: 'A password on its own, with nothing to sign in to.',
    icon: 0,
    labels: {},
    hide: ['username', 'url'],
    fields: []
  },
  note: {
    key: 'note',
    name: 'Secure note',
    hint: 'Text you want encrypted, and nothing else.',
    icon: 44,
    labels: {},
    hide: ['username', 'password', 'url'],
    fields: []
  },
  card: {
    key: 'card',
    name: 'Card',
    hint: 'A payment card. The number goes in the password field, so it is protected and concealed like one.',
    icon: 66,
    labels: { username: 'Cardholder', password: 'Card number' },
    hide: ['url'],
    fields: [
      { key: 'Expiry', protected: false },
      { key: 'Security code', protected: true },
      { key: 'PIN', protected: true },
      { key: 'Issuer', protected: false }
    ]
  },
  identity: {
    key: 'identity',
    name: 'Identity',
    hint: 'Who you are on paper. The numbered documents are protected.',
    icon: 9,
    labels: { username: 'Full name' },
    hide: ['password', 'url'],
    fields: [
      { key: 'Date of birth', protected: false },
      { key: 'Address', protected: false },
      { key: 'Phone', protected: false },
      { key: 'Email', protected: false },
      { key: 'Passport number', protected: true },
      { key: 'Licence number', protected: true },
      { key: 'Social security number', protected: true }
    ]
  },
  alias: {
    key: 'alias',
    name: 'Email alias',
    hint: 'A forwarding address and the site you made it for. Propolis cannot mint one for you yet.',
    icon: 19,
    labels: { username: 'Alias address', url: 'Used at' },
    hide: ['password'],
    fields: [
      { key: 'Forwards to', protected: false },
      { key: 'Provider', protected: false }
    ]
  }
};

const DEFAULT_TYPE = 'login';

function typeFor(key) {
  return TYPES[String(key || '').toLowerCase()] || TYPES[DEFAULT_TYPE];
}

/** Reads the marker off a serialized entry's custom fields. */
function typeOfEntry(entry) {
  const fields = (entry && entry.customFields) || [];
  const marker = fields.find((f) => f.key === TYPE_FIELD);
  const key = marker && String(marker.value || '').toLowerCase();
  return TYPES[key] ? key : DEFAULT_TYPE;
}

/** Everything the window needs to draw the types, in one payload. */
function choices() {
  return Object.values(TYPES).map((t) => ({
    key: t.key,
    name: t.name,
    hint: t.hint,
    icon: t.icon,
    labels: { ...t.labels },
    hide: t.hide.slice(),
    fields: t.fields.map((f) => ({ ...f }))
  }));
}

module.exports = {
  TYPE_FIELD,
  TYPES,
  DEFAULT_TYPE,
  typeFor,
  typeOfEntry,
  choices
};
