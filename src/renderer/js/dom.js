/* Small DOM helpers. Everything user supplied goes in through textContent, so
   an entry titled "<img onerror=...>" is just text. */
window.IV = window.IV || {};

(function (IV) {
  'use strict';

  /* Screen capture protection is a whole window flag, so the main process only
     needs to know whether anything is revealed, not what. Counting the reveal
     buttons that are currently on is simpler than tracking every caller, and it
     cannot fall out of step with what is actually on screen. Called after any
     reveal toggles; the result is only sent when it changes. */
  let lastReported = null;

  function reportSecrets() {
    const visible = document.querySelectorAll('.reveal.on, [data-reveal].on').length > 0;
    if (visible === lastReported) return;
    lastReported = visible;
    if (IV.api && IV.api.secretsVisible) IV.api.secretsVisible(visible).catch(() => {});
  }

  /**
   * append, but a null child is skipped rather than printed.
   *
   * Element.append turns anything that is not a Node into text, so
   * `parent.append(cond ? h(...) : null)` puts the word "null" on the screen.
   * h already filters its own children this way; this is the same courtesy for
   * the places that append after building.
   */
  function add(parent, ...children) {
    for (const child of children.flat()) {
      if (child == null || child === false) continue;
      parent.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return parent;
  }

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value == null || value === false) continue;
        if (key === 'class') el.className = value;
        else if (key === 'text') el.textContent = value;
        else if (key === 'html') el.innerHTML = value; // only ever called with literals
        else if (key === 'dataset') Object.assign(el.dataset, value);
        else if (key === 'vars') for (const [k, v] of Object.entries(value)) el.style.setProperty(k, v);
        else if (key === 'onActivate' && typeof value === 'function') {
          // A div or li that behaves like a control has to be reachable and
          // triggerable from the keyboard, not only clickable.
          if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
          el.addEventListener('click', value);
          el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
              e.preventDefault();
              value(e);
            }
          });
        } else if (key.startsWith('on') && typeof value === 'function') {
          el.addEventListener(key.slice(2).toLowerCase(), value);
        } else if (key === 'value') el.value = value;
        else if (key === 'checked' || key === 'disabled' || key === 'hidden' || key === 'readOnly') el[key] = Boolean(value);
        else el.setAttribute(key, value === true ? '' : String(value));
      }
    }
    for (const child of children.flat()) {
      if (child == null || child === false) continue;
      el.append(child.nodeType ? child : document.createTextNode(String(child)));
    }

    // An icon button says nothing to a screen reader: its label is a CSS
    // glyph. Borrow the tooltip, which every one of them already sets.
    if (
      el.tagName === 'BUTTON' &&
      !el.textContent.trim() &&
      !el.hasAttribute('aria-label') &&
      el.hasAttribute('title')
    ) {
      el.setAttribute('aria-label', el.getAttribute('title'));
    }

    return el;
  }

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  /* --------------------------------------------------------------- toast */

  let toastTimer = null;
  function toast(message, kind) {
    const root = $('#toast-root');
    const node = h('div', { class: 'toast' + (kind ? ' ' + kind : ''), text: message });
    clear(root).append(node);
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.remove(), kind === 'error' ? 4200 : 2100);
    // The toast root is a live region, so this reaches a screen reader too.
    announce(message, kind === 'error' ? 'assertive' : 'polite');
  }

  /**
   * Speaks a message without showing anything. Used for things a sighted user
   * infers from the screen changing, like a list reloading after a search.
   */
  let announceTimer = null;
  function announce(message, urgency = 'polite') {
    const region = $(urgency === 'assertive' ? '#sr-alert' : '#sr-status');
    if (!region) return;
    // Clearing first makes repeats of the same text announce again.
    region.textContent = '';
    if (announceTimer) clearTimeout(announceTimer);
    announceTimer = setTimeout(() => {
      region.textContent = String(message || '');
    }, 60);
  }

  /* --------------------------------------------------------------- modal */

  const modalStack = [];

  const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), ' +
    'select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

  function focusableWithin(root) {
    return $$(FOCUSABLE, root).filter((el) => el.offsetParent !== null || el === document.activeElement);
  }

  function modal({ title, body, footer, wide, onClose, initialFocus }) {
    const titleId = 'modal-title-' + Math.random().toString(36).slice(2, 9);
    const returnFocusTo = document.activeElement;

    const dialog = h(
      'div',
      {
        class: 'modal' + (wide ? ' wide' : ''),
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': titleId,
        tabindex: '-1'
      },
      h(
        'div',
        { class: 'modal-head' },
        h('h2', { id: titleId, text: title || '' }),
        h('button', { class: 'icon-btn close', title: tr('Close'), onClick: () => close() })
      ),
      h('div', { class: 'modal-body' }, body),
      footer ? h('div', { class: 'modal-foot' }, footer) : null
    );

    const backdrop = h(
      'div',
      {
        class: 'modal-backdrop',
        onMousedown: (e) => {
          if (e.target === backdrop) close();
        }
      },
      dialog
    );

    // Tab must not escape an open dialog, or focus lands on the page behind it
    // where a screen reader will happily read content the user cannot see.
    dialog.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const items = focusableWithin(dialog);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });

    function close(result) {
      const index = modalStack.indexOf(handle);
      if (index >= 0) modalStack.splice(index, 1);
      backdrop.remove();
      // Put focus back where it came from, so keyboard users do not get
      // dropped at the top of the page.
      if (returnFocusTo && document.contains(returnFocusTo)) {
        try {
          returnFocusTo.focus();
        } catch {
          /* the element may have been replaced by a refresh */
        }
      }
      if (onClose) onClose(result);
    }

    const handle = { close, dialog, backdrop };
    modalStack.push(handle);
    $('#modal-root').append(backdrop);

    // Prefer somewhere typing makes sense, then the confirming button. A range
    // slider must not win, since arrow keys would then change a value the user
    // never meant to touch. The dialog itself is the last resort, so focus can
    // never be left on the page behind.
    const preferred =
      (initialFocus && $(initialFocus, dialog)) ||
      dialog.querySelector('[autofocus]') ||
      dialog.querySelector(
        '.modal-body input[type="text"], .modal-body input[type="password"], ' +
          '.modal-body input[type="search"], .modal-body input[type="number"], .modal-body textarea'
      ) ||
      dialog.querySelector('.modal-foot button.primary') ||
      focusableWithin(dialog)[0] ||
      dialog;

    setTimeout(() => {
      try {
        preferred.focus();
        if (!dialog.contains(document.activeElement)) dialog.focus();
      } catch {
        dialog.focus();
      }
    }, 20);
    announce(title ? title + ' dialog' : 'Dialog opened');
    return handle;
  }

  function topModal() {
    return modalStack[modalStack.length - 1] || null;
  }

  /* ------------------------------------------------------------ formatting */

  const AVATAR_COLORS = [
    '#5b8dfb', '#8f6bff', '#e0699b', '#f2686a', '#f0904a',
    '#e2b93b', '#5fbf6a', '#2fb3a6', '#4aa8d8', '#8a8fa8'
  ];

  function avatarColor(text) {
    const s = String(text || '?');
    let hash = 0;
    for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
    return AVATAR_COLORS[hash % AVATAR_COLORS.length];
  }

  function initials(text) {
    const s = String(text || '').trim();
    if (!s) return '?';
    const parts = s.split(/[\s._-]+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return s.slice(0, 2).toUpperCase();
  }

  function avatar(item, className) {
    const node = h('div', { class: 'avatar' + (className ? ' ' + className : '') });
    if (item && item.customIcon) {
      node.append(h('img', { src: item.customIcon, alt: '' }));
    } else {
      node.style.setProperty('background', avatarColor(item ? item.title || item.name : ''));
      node.textContent = initials(item ? item.title || item.name : '');
    }
    return node;
  }

  function formatDate(ms) {
    if (!ms) return 'Never';
    const d = new Date(ms);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) +
      ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  function formatRelative(ms) {
    if (!ms) return 'never';
    const diff = Date.now() - ms;
    const mins = Math.round(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + (mins === 1 ? ' minute ago' : ' minutes ago');
    const hours = Math.round(mins / 60);
    if (hours < 24) return hours + (hours === 1 ? ' hour ago' : ' hours ago');
    const days = Math.round(hours / 24);
    if (days < 31) return days + (days === 1 ? ' day ago' : ' days ago');
    const months = Math.round(days / 30.4);
    if (months < 24) return months + (months === 1 ? ' month ago' : ' months ago');
    return Math.round(months / 12) + ' years ago';
  }

  function formatSize(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    return (unit === 0 ? value : value.toFixed(1)) + ' ' + units[unit];
  }

  /**
   * Six segments, one per strength level, with the count filled matching the
   * level. The number of blocks carries the meaning, so the meter still reads
   * correctly with no colour vision at all.
   */
  function strengthMeter(estimate, { summary = true } = {}) {
    const level = Math.max(0, Math.min(6, estimate.level != null ? estimate.level : 0));
    const segments = h('div', { class: 'strength-segments', role: 'img' });
    for (let i = 0; i <= 6; i++) {
      segments.append(h('div', { class: 'strength-seg' + (i <= level ? ' on' : '') }));
    }

    const text = summary ? estimate.summary : estimate.label + ' · ' + estimate.bits + ' bits';
    segments.setAttribute('aria-label', text);

    return h(
      'div',
      { class: 'strength', dataset: { level: String(level) } },
      segments,
      h('span', { class: 'strength-summary', text })
    );
  }

  IV.dom = {
    h,
    $,
    $$,
    clear,
    toast,
    modal,
    topModal,
    avatar,
    avatarColor,
    initials,
    formatDate,
    formatRelative,
    formatSize,
    strengthMeter,
    announce,
    focusableWithin,
    reportSecrets,
    add
  };
})(window.IV);
