'use strict';

/**
 * The four themes, and the identity each one carries.
 *
 * A theme is a name, an icon and a palette together, because switching to
 * Propolis is meant to feel like a different product rather than a recolour.
 * The two CB themes keep their sibling's accent, since blue and amber are both
 * already distinguishable under every common form of colour blindness. What
 * they replace is the meaning colours, because green against red is the pair
 * that merges.
 *
 * What a theme cannot change is anything Windows fixed when the app was built:
 * the executable's name, the Start menu shortcut, and the entry under
 * Installed apps.
 */

const THEMES = {
  'ironvault-cb': {
    key: 'ironvault-cb',
    name: 'Ironvault',
    label: 'IronvaultCB, the original with colourblind safe meanings',
    icon: 'blue',
    colourblind: true,
    tagline: 'Your KeePass databases, on Windows.'
  },
  ironvault: {
    key: 'ironvault',
    name: 'Ironvault',
    label: 'Ironvault, the original blue and violet',
    icon: 'blue',
    colourblind: false,
    tagline: 'Your KeePass databases, on Windows.'
  },
  'propolis-cb': {
    key: 'propolis-cb',
    name: 'Propolis',
    label: 'PropolisCB, honey and resin with colourblind safe meanings',
    icon: 'default',
    colourblind: true,
    tagline: 'The resin that seals the hive.'
  },
  propolis: {
    key: 'propolis',
    name: 'Propolis',
    label: 'Propolis, honey and resin',
    icon: 'default',
    colourblind: false,
    tagline: 'The resin that seals the hive.'
  }
};

const DEFAULT_THEME = 'ironvault-cb';

function themeFor(key) {
  return THEMES[key] || THEMES[DEFAULT_THEME];
}

function productNameFor(key) {
  return themeFor(key).name;
}

function taglineFor(key) {
  return themeFor(key).tagline;
}

/** Which icon file a theme uses. Both Ironvault themes share one, as do both Propolis. */
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
  THEMES,
  DEFAULT_THEME,
  themeFor,
  productNameFor,
  taglineFor,
  iconKeyFor,
  choices
};
