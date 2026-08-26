/* Security audit: weak, reused, ageing, expired, and empty passwords. */
window.IV = window.IV || {};

(function (IV) {
  'use strict';

  const { h, modal, toast, avatar, formatRelative } = IV.dom;

  function entryRow(entry, why, close) {
    return h(
      'li',
      {
        class: 'audit-item',
        onClick: async () => {
          close();
          await IV.app.showEntry(entry.id);
        }
      },
      avatar(entry),
      h(
        'div',
        { class: 'entry-main' },
        h('div', { class: 'entry-title', text: entry.title || '(no title)' }),
        h('div', { class: 'entry-sub', text: [entry.username, entry.groupName].filter(Boolean).join(' · ') })
      ),
      why ? h('span', { class: 'why', text: why }) : null
    );
  }

  function section(title, count, children) {
    if (!count) return null;
    return h(
      'details',
      { class: 'audit-group' },
      h('summary', { text: title + ' (' + count + ')' }),
      children
    );
  }

  async function openAudit() {
    let report;
    try {
      report = await IV.api.audit();
    } catch (err) {
      toast(err.message, 'error');
      return;
    }

    const problems =
      report.weak.length + report.duplicates.length + report.noPassword.length + report.expired.length;

    const stats = h(
      'div',
      { class: 'audit-summary' },
      h('div', { class: 'audit-stat' }, h('b', { text: String(report.total) }), h('span', { text: 'entries' })),
      h(
        'div',
        { class: 'audit-stat ' + (report.weak.length ? 'bad' : 'ok') },
        h('b', { text: String(report.weak.length) }),
        h('span', { text: 'weak' })
      ),
      h(
        'div',
        { class: 'audit-stat ' + (report.duplicates.length ? 'warn' : 'ok') },
        h('b', { text: String(report.duplicates.length) }),
        h('span', { text: 'reused' })
      ),
      h(
        'div',
        { class: 'audit-stat ' + (report.expired.length ? 'warn' : 'ok') },
        h('b', { text: String(report.expired.length) }),
        h('span', { text: 'expired' })
      ),
      h(
        'div',
        { class: 'audit-stat ' + (report.old.length ? 'warn' : 'ok') },
        h('b', { text: String(report.old.length) }),
        h('span', { text: 'over 2 years' })
      )
    );

    const close = () => handle.close();

    const body = h(
      'div',
      null,
      stats,
      problems === 0
        ? h('p', { class: 'empty-note', text: 'Nothing needs attention. Every password is unique and reasonably strong.' })
        : null,
      section(
        'Weak passwords',
        report.weak.length,
        h(
          'ul',
          { class: 'audit-list' },
          report.weak.map((e) => entryRow(e, e.strength ? e.strength.label : '', close))
        )
      ),
      section(
        'Reused passwords',
        report.duplicates.length,
        h(
          'div',
          { class: 'audit-list' },
          report.duplicates.map((group) =>
            h(
              'div',
              { class: 'dup-set' },
              h('ul', { class: 'audit-list' }, group.map((e) => entryRow(e, '', close)))
            )
          )
        )
      ),
      section(
        'No password set',
        report.noPassword.length,
        h('ul', { class: 'audit-list' }, report.noPassword.map((e) => entryRow(e, '', close)))
      ),
      section(
        'Expired',
        report.expired.length,
        h('ul', { class: 'audit-list' }, report.expired.map((e) => entryRow(e, formatRelative(e.expiryTime), close)))
      ),
      section(
        'Not changed in over two years',
        report.old.length,
        h('ul', { class: 'audit-list' }, report.old.map((e) => entryRow(e, formatRelative(e.modified), close)))
      )
    );

    const handle = modal({ title: 'Security audit', wide: true, body });
  }

  IV.audit = { openAudit };
})(window.IV);
