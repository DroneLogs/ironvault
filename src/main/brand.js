'use strict';

/**
 * The app's own identity, which the icon choice can change.
 *
 * Picking Propolis renames the running app and swaps its mark for the resin
 * coloured one. What it cannot change is anything Windows fixed at install
 * time: the executable's name, the Start menu shortcut, and the entry under
 * Installed apps all keep the name the build was made with.
 */

const BRANDS = {
  default: {
    key: 'default',
    name: 'Ironvault',
    label: 'Ironvault, honey amber',
    tagline: 'Your KeePass databases, on Windows.'
  },
  propolis: {
    key: 'propolis',
    name: 'Propolis',
    label: 'Propolis, resin red (renames the app)',
    tagline: 'The resin that seals the hive.'
  },
  blue: { key: 'blue', name: 'Ironvault', label: 'Blue' },
  green: { key: 'green', name: 'Ironvault', label: 'Green' },
  crimson: { key: 'crimson', name: 'Ironvault', label: 'Crimson' },
  slate: { key: 'slate', name: 'Ironvault', label: 'Slate' }
};

function brandFor(iconKey) {
  return BRANDS[iconKey] || BRANDS.default;
}

function productNameFor(iconKey) {
  return brandFor(iconKey).name;
}

function taglineFor(iconKey) {
  return brandFor(iconKey).tagline || BRANDS.default.tagline;
}

function choices() {
  return Object.values(BRANDS).map((b) => ({ key: b.key, name: b.label, product: b.name }));
}

module.exports = { BRANDS, brandFor, productNameFor, taglineFor, choices };
