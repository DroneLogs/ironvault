/* Small DOM helpers. Everything user supplied goes in through textContent, so
   an entry titled "<img onerror=...>" is just text. */
window.IV = window.IV || {};

(function (IV) {
  'use strict';

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
        else if (key.startsWith('on') && typeof value === 'function') {
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
  }

  /* --------------------------------------------------------------- modal */

  const modalStack = [];

  function modal({ title, body, footer, wide, onClose, initialFocus }) {
    const dialog = h(
      'div',
      { class: 'modal' + (wide ? ' wide' : '') },
      h(
        'div',
        { class: 'modal-head' },
        h('h2', { text: title || '' }),
        h('button', { class: 'icon-btn close', title: 'Close', onClick: () => close() })
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

    function close(result) {
      const index = modalStack.indexOf(handle);
      if (index >= 0) modalStack.splice(index, 1);
      backdrop.remove();
      if (onClose) onClose(result);
    }

    const handle = { close, dialog, backdrop };
    modalStack.push(handle);
    $('#modal-root').append(backdrop);

    const focusTarget = initialFocus ? $(initialFocus, dialog) : dialog.querySelector('input, textarea, button.primary');
    if (focusTarget) setTimeout(() => focusTarget.focus(), 20);
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
    const level = Math.max(0, Math.min(5, estimate.level != null ? estimate.level : 0));
    const segments = h('div', { class: 'strength-segments', role: 'img' });
    for (let i = 0; i <= 5; i++) {
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
    strengthMeter
  };
})(window.IV);
