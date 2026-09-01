/**
 * Translation.
 *
 * Every user facing string in the renderer is written in English in the source
 * and looked up here. A missing translation returns the English, so a partly
 * translated language is usable rather than full of blanks, and adding a
 * language is a file of pairs rather than a change to any screen.
 *
 * Only literals in the source are ever passed through here. Entry titles,
 * usernames and notes are the user's own words and are never looked up: a
 * database with an entry called "Settings" must not have it renamed on screen
 * because a menu happens to use the same word.
 *
 * The language applies on restart. Strings are read as each screen is built, so
 * changing it live would leave the parts already on screen in the old language,
 * and rebuilding everything would drop the user back at the lock screen with
 * the database still open behind it.
 */
(function (IV) {
  'use strict';

  const tables = {};
  let active = 'en';
  let table = null;

  /**
   * Read straight from the preload rather than fetched.
   *
   * Some lists are built as their file loads, before any asynchronous call
   * could have answered, and those would be stuck in English for the life of
   * the window. The language has to be known before the first line of any
   * other script runs, so it arrives synchronously.
   */
  const desired = (window.propolis && window.propolis.language) || 'en';

  /** A locale file calls this as it loads. */
  function register(code, name, pairs) {
    tables[code] = { name, pairs: pairs || {} };
    // The wanted language may register after this file has already settled on
    // English, so take it the moment it turns up.
    if (code === desired) use(desired);
  }

  function use(code) {
    active = tables[code] ? code : 'en';
    table = tables[active] ? tables[active].pairs : null;
  }

  /**
   * The English string, or its translation.
   *
   * Named for what it does at the call site, where it has to be short enough
   * that wrapping every label in it does not bury the label.
   */
  function t(text, vars) {
    let out = (table && table[text]) || text;
    if (vars) {
      for (const key of Object.keys(vars)) {
        out = out.split('{' + key + '}').join(String(vars[key]));
      }
    }
    return out;
  }

  function available() {
    return [{ code: 'en', name: 'English' }].concat(
      Object.keys(tables)
        .filter((c) => c !== 'en')
        .map((c) => ({ code: c, name: tables[c].name }))
    );
  }

  /**
   * Translates the markup the app ships with.
   *
   * Safe only because it runs once, before any database is open, so nothing on
   * screen is the user's own text yet. It is never called again.
   */
  function translateStatic(root) {
    if (active === 'en' || !table) return;
    const scope = root || document.body;

    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let node;
    while ((node = walker.nextNode())) nodes.push(node);
    for (const text of nodes) {
      const value = text.nodeValue.trim();
      if (!value || !table[value]) continue;
      text.nodeValue = text.nodeValue.replace(value, table[value]);
    }

    for (const attr of ['placeholder', 'title', 'aria-label', 'value']) {
      for (const el of scope.querySelectorAll('[' + attr + ']')) {
        const value = el.getAttribute(attr);
        if (value && table[value]) el.setAttribute(attr, table[value]);
      }
    }
  }

  IV.i18n = { register, use, t, available, translateStatic, current: () => active };

  // Global on purpose. Every renderer file needs it on nearly every line, and
  // an import line at the top of each one is noise that would get forgotten.
  //
  // Named tr rather than t because several callbacks already take a tag as t,
  // and a shadowed translator would throw only on the screens that use one.
  window.tr = t;
})((window.IV = window.IV || {}));
