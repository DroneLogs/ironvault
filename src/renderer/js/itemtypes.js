/* Item types, as the window sees them. The catalogue itself comes from the main
   process at boot, so there is one definition of what a Card is, not two. */
window.IV = window.IV || {};

(function (IV) {
  'use strict';

  /** Falls back to a bare Login, so the editor still works if the list is late. */
  const FALLBACK = {
    key: 'login',
    name: 'Login',
    hint: '',
    icon: 0,
    labels: {},
    hide: [],
    fields: []
  };

  function all() {
    const list = (IV.state && IV.state.itemTypes) || [];
    return list.length ? list : [FALLBACK];
  }

  function get(key) {
    return all().find((t) => t.key === key) || all()[0];
  }

  /** The name of the custom field holding the marker. */
  function markerField() {
    return (IV.state && IV.state.itemTypeField) || 'PROPOLIS_TYPE';
  }

  /** Which type an entry is, read off its own fields. Anything else is a Login. */
  function of(entry) {
    const fields = (entry && entry.customFields) || [];
    const marker = fields.find((f) => f.key === markerField());
    const key = marker && String(marker.value || '').toLowerCase();
    return all().some((t) => t.key === key) ? key : 'login';
  }

  /** The label a type gives one of the built in fields. */
  function labelFor(type, field, fallback) {
    return (type && type.labels && type.labels[field]) || fallback;
  }

  function hides(type, field) {
    return Boolean(type && type.hide && type.hide.includes(field));
  }

  IV.itemTypes = { all, get, of, markerField, labelFor, hides };
})(window.IV);
