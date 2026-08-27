'use strict';

/**
 * The four palettes, and the identity the app carries.
 *
 * The product is Propolis. A palette is a look and an icon together, not a
 * different product, so the name on the window is the same whichever one is
 * chosen. The two CB palettes keep their sibling's accent, since blue and amber
 * are both already distinguishable under every common form of colour blindness.
 * What they replace is the meaning colours, because green against red is the
 * pair that merges.
 *
 * What a palette cannot change is anything Windows fixed when the app was
 * built: the executable's name, the Start menu shortcut, and the entry under
 * Installed apps.
 */

const PRODUCT_NAME = 'Propolis';
const TAGLINE = 'Your KeePass databases, on Windows.';

const THEMES = {
  'blue-cb': {
    key: 'blue-cb',
    name: PRODUCT_NAME,
    label: 'Blue CB, the original with colourblind safe meanings',
    icon: 'blue',
    colourblind: true,
    tagline: TAGLINE
  },
  blue: {
    key: 'blue',
    name: PRODUCT_NAME,
    label: 'Blue, the original blue and violet',
    icon: 'blue',
    colourblind: false,
    tagline: TAGLINE
  },
  'amber-cb': {
    key: 'amber-cb',
    name: PRODUCT_NAME,
    label: 'Amber CB, honey and resin with colourblind safe meanings',
    icon: 'amber',
    colourblind: true,
    tagline: TAGLINE
  },
  amber: {
    key: 'amber',
    name: PRODUCT_NAME,
    label: 'Amber, honey and resin',
    icon: 'amber',
    colourblind: false,
    tagline: TAGLINE
  }
};

const DEFAULT_THEME = 'blue-cb';

/**
 * Palettes used to be named after two products, Ironvault and Propolis, back
 * when picking one renamed the running app. Profiles written then still hold
 * the old keys, so they are translated on the way in.
 */
const RENAMED = {
  'ironvault-cb': 'blue-cb',
  ironvault: 'blue',
  'propolis-cb': 'amber-cb',
  propolis: 'amber'
};

function migrateThemeKey(key) {
  return RENAMED[key] || key;
}

function themeFor(key) {
  return THEMES[migrateThemeKey(key)] || THEMES[DEFAULT_THEME];
}

function productNameFor() {
  return PRODUCT_NAME;
}

function taglineFor(key) {
  return themeFor(key).tagline;
}

/**
 * Which icon file a palette uses. Both blues share one, as do both ambers.
 * The name is the suffix: build/icon-<key>.ico and renderer/icons/app-<key>.png.
 */
function iconKeyFor(key) {
  return themeFor(key).icon;
}

function choices() {
  return Object.values(THEMES).map((t) => ({
    key: t.key,
    name: t.label,
    product: t.name,
    colourblind: t.colourblind
  }));
}

module.exports = {
  PRODUCT_NAME,
  THEMES,
  DEFAULT_THEME,
  migrateThemeKey,
  themeFor,
  productNameFor,
  taglineFor,
  iconKeyFor,
  choices
};
