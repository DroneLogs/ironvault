/* Dialogs for everything that operates on the whole database: comparing,
   syncing, importing, auditing, backups, and the unlock and desktop settings. */
window.IV = window.IV || {};

(function (IV) {
  'use strict';

  const { h, clear, toast, modal, avatar, formatDate, formatSize, formatRelative } = IV.dom;

  function field(label, control, hint) {
    return h(
      'div',
      { class: 'field' },
      h('span', { class: 'field-label', text: label }),
      control,
      hint ? h('p', { class: 'hint', text: hint }) : null
    );
  }

  function toggle(label, checked, onChange, hint) {
    const input = h('input', { type: 'checkbox', checked, onChange: () => onChange(input.checked) });
    return h(
      'label',
      { class: 'checkline' },
      input,
      h('span', null, h('span', { text: label }), hint ? h('small', { class: 'checkhint', text: hint }) : null)
    );
  }

  function entryRow(summary, extra) {
    return h(
      'li',
      {
        class: 'audit-item',
        role: 'button',
        'aria-label':
          (summary.title || 'no title') +
          (summary.username ? ', ' + summary.username : '') +
          (extra ? ', ' + extra : ''),
        onActivate: () => {
          const top = IV.dom.topModal();
          if (top) top.close();
          IV.app.showEntry(summary.id);
        }
      },
      avatar(summary),
      h(
        'div',
        { class: 'entry-main' },
        h('div', { class: 'entry-title', text: summary.title || '(no title)' }),
        h('div', { class: 'entry-sub', text: [summary.username, summary.groupName].filter(Boolean).join(' · ') })
      ),
      extra ? h('span', { class: 'why', text: extra }) : null
    );
  }

  /* --------------------------------------------------------- credentials */

  /** Asks for the password of another database file. */
  function askCredentials(title, filePath) {
    return new Promise((resolve) => {
      const password = h('input', { type: 'password', autocomplete: 'off' });
      const keyPath = h('input', { type: 'text', readOnly: true, placeholder: 'None' });
      let settled = false;

      const handle = modal({
        title,
        body: h(
          'div',
          null,
          h('p', { class: 'path-line', text: filePath }),
          field('Master password', password),
          field(
            'Key file (optional)',
            h(
              'div',
              { class: 'row-gap' },
              keyPath,
              h('button', {
                class: 'btn ghost small',
                text: 'Choose',
                onClick: async () => {
                  const picked = await IV.api.chooseKeyFile();
                  if (picked) keyPath.value = picked;
                }
              }),
              h('button', { class: 'btn ghost small', text: 'Clear', onClick: () => (keyPath.value = '') })
            )
          )
        ),
        footer: [
          h('button', { class: 'btn ghost', text: 'Cancel', onClick: () => handle.close() }),
          h('button', {
            class: 'btn primary',
            text: 'Continue',
            onClick: () => {
              settled = true;
              const result = { password: password.value, keyFilePath: keyPath.value || null };
              handle.close();
              resolve(result);
            }
          })
        ],
        onClose: () => {
          if (!settled) resolve(null);
        }
      });

      password.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          settled = true;
          const result = { password: password.value, keyFilePath: keyPath.value || null };
          handle.close();
          resolve(result);
        }
      });
    });
  }

  /* ------------------------------------------------------------- compare */

  async function openCompare() {
    const filePath = await IV.api.chooseCompare();
    if (!filePath) return;
    const credentials = await askCredentials('Unlock the database to compare', filePath);
    if (!credentials) return;

    let report;
    try {
      report = await IV.api.compareDb({ filePath, ...credentials });
    } catch (err) {
      toast(err.message, 'error');
      return;
    }

    const stat = (label, value, kind) =>
      h('div', { class: 'audit-stat ' + (kind || '') }, h('b', { text: String(value) }), h('span', { text: label }));

    const body = h(
      'div',
      null,
      h(
        'div',
        { class: 'audit-summary' },
        stat('identical', report.totals.identical, 'ok'),
        stat('different', report.totals.changed, report.totals.changed ? 'warn' : 'ok'),
        stat('only here', report.totals.onlyLocal, report.totals.onlyLocal ? 'warn' : 'ok'),
        stat('only there', report.totals.onlyRemote, report.totals.onlyRemote ? 'warn' : 'ok')
      ),
      h('p', { class: 'hint', text: report.localName + '  vs  ' + report.remoteName })
    );

    if (report.changed.length) {
      const list = h('div', { class: 'audit-list' });
      for (const item of report.changed) {
        const rows = item.differences.map((d) =>
          h(
            'div',
            { class: 'diff-row' },
            h('span', { class: 'diff-field', text: d.field }),
            h('span', { class: 'diff-left', text: d.left || '(empty)' }),
            h('span', { class: 'diff-arrow', text: '→' }),
            h('span', { class: 'diff-right', text: d.right || '(empty)' })
          )
        );
        list.append(
          h(
            'details',
            { class: 'audit-group' },
            h('summary', {
              text:
                (item.local.title || '(no title)') +
                '  ·  ' +
                item.differences.length +
                (item.differences.length === 1 ? ' difference' : ' differences') +
                (item.newer === 'local' ? '  ·  this copy is newer' : '  ·  the other copy is newer')
            }),
            h('div', { class: 'diff-body' }, rows)
          )
        );
      }
      body.append(h('div', { class: 'detail-section' }, h('h3', { text: 'Different' }), list));
    }

    const listOf = (title, items) => {
      if (!items.length) return null;
      return h(
        'details',
        { class: 'audit-group' },
        h('summary', { text: title + ' (' + items.length + ')' }),
        h('ul', { class: 'audit-list' }, items.map((s) => entryRow(s)))
      );
    };

    const extras = h(
      'div',
      { class: 'detail-section' },
      listOf('Only in this database', report.onlyLocal),
      listOf('Only in the other database', report.onlyRemote)
    );
    if (extras.childElementCount) body.append(extras);

    const handle = modal({
      title: 'Compare databases',
      wide: true,
      body,
      footer: [
        h('button', { class: 'btn ghost', text: 'Close', onClick: () => handle.close() }),
        h('span', { class: 'spacer' }),
        h('button', {
          class: 'btn primary',
          text: 'Merge the other one in',
          onClick: async () => {
            const ok = await IV.api.confirm({
              title: 'Merge databases',
              message: 'Merge ' + report.remoteName + ' into this database?',
              detail:
                'Entries only in the other file are added, and newer versions win where both changed. ' +
                'Nothing is deleted. A backup is written first.',
              confirmLabel: 'Merge'
            });
            if (!ok) return;
            try {
              const result = await IV.api.mergeDb({ filePath, ...credentials });
              handle.close();
              await IV.app.refresh();
              await IV.app.autoSave();
              toast('Merged, ' + result.added + ' entries added', 'good');
            } catch (err) {
              toast(err.message, 'error');
            }
          }
        })
      ]
    });
  }

  /* --------------------------------------------------------------- audits */

  async function openPwned() {
    const ok = await IV.api.confirm({
      title: 'Have I Been Pwned',
      message: 'Check your passwords against known breaches?',
      detail:
        'Only the first five characters of each password’s SHA-1 hash are sent, and the reply covers hundreds ' +
        'of hashes, so the service cannot tell which password was asked about. No other part of any entry leaves this PC.',
      confirmLabel: 'Check'
    });
    if (!ok) return;

    const status = h('p', { class: 'update-status', text: 'Checking...' });
    const results = h('div');
    const handle = modal({
      title: 'Have I Been Pwned',
      wide: true,
      body: h('div', null, h('div', { class: 'with-help' }, status, IV.glossary.badge('pwned')), results)
    });

    const stop = IV.api.on('progress', (p) => {
      if (p.job === 'pwned') status.textContent = 'Checking... ' + p.done + ' of ' + p.total + ' ranges';
    });

    try {
      const report = await IV.api.auditPwned();
      status.textContent =
        report.breached.length === 0
          ? 'None of your ' + report.checked + ' passwords appear in a known breach.'
          : report.breached.length + ' of ' + report.checked + ' passwords appear in known breaches.';
      status.className = 'update-status' + (report.breached.length ? ' error-line' : '');

      if (report.breached.length) {
        results.append(
          h(
            'ul',
            { class: 'audit-list' },
            report.breached.map((e) => entryRow(e, e.breachCount.toLocaleString() + ' times'))
          )
        );
      }
      if (report.errors.length) {
        results.append(h('p', { class: 'hint', text: 'Some checks failed: ' + report.errors.join('; ') }));
      }
    } catch (err) {
      status.textContent = err.message;
      status.className = 'update-status error-line';
    } finally {
      stop();
    }
  }

  async function openSimilar() {
    let report;
    try {
      report = await IV.api.auditSimilar({ threshold: 0.7 });
    } catch (err) {
      toast(err.message, 'error');
      return;
    }

    const body = h('div', null);
    if (!report.pairs.length) {
      body.append(
        h('p', { class: 'empty-note', text: 'No two passwords are close enough to be worth flagging.' })
      );
    } else {
      body.append(
        h('p', {
          class: 'hint',
          text:
            report.pairs.length +
            ' pair' +
            (report.pairs.length === 1 ? '' : 's') +
            ' of entries use passwords that are variations on each other.'
        })
      );
      for (const pair of report.pairs) {
        body.append(
          h(
            'div',
            { class: 'dup-set' },
            h('div', { class: 'why', text: pair.similarity + '% alike' }),
            h('ul', { class: 'audit-list' }, entryRow(pair.a), entryRow(pair.b))
          )
        );
      }
    }

    modal({ title: 'Find similar passwords', wide: true, body });
  }

  async function openFavicons() {
    const ok = await IV.api.confirm({
      title: 'Download favicons',
      message: 'Fetch website icons for every entry that has a URL?',
      detail: 'Propolis will contact each site to download its icon. Entries that already have an icon are skipped.',
      confirmLabel: 'Download'
    });
    if (!ok) return;

    const status = h('p', { class: 'update-status', text: 'Starting...' });
    const results = h('div');
    const handle = modal({ title: 'Favicon downloader', body: h('div', null, status, results) });

    const stop = IV.api.on('progress', (p) => {
      if (p.job === 'favicons') status.textContent = 'Fetching... ' + p.done + ' of ' + p.total;
    });

    try {
      const report = await IV.api.faviconAll(false);
      status.textContent = report.succeeded + ' of ' + report.total + ' icons downloaded.';
      if (report.failures.length) {
        results.append(
          h('details', { class: 'audit-group' },
            h('summary', { text: report.failures.length + ' could not be fetched' }),
            h('div', { class: 'audit-list' },
              report.failures.map((f) => h('div', { class: 'diff-row' },
                h('span', { class: 'diff-field', text: f.title }),
                h('span', { class: 'diff-left', text: f.error })))
            ))
        );
      }
      await IV.app.refresh();
      await IV.app.autoSave();
    } catch (err) {
      status.textContent = err.message;
      status.className = 'update-status error-line';
    } finally {
      stop();
    }
  }

  /* ------------------------------------------------------- import, export */

  function openTransfer() {
    const handle = modal({
      title: 'Import and export',
      body: h(
        'div',
        null,
        h('div', { class: 'detail-section' }, h('h3', { text: 'Import' })),
        h('p', { class: 'hint', text: 'CSV from most password managers, KeePass XML, and 1Password .1pux archives.' }),
        h(
          'div',
          { class: 'row-gap' },
          h('button', {
            class: 'btn primary small',
            text: 'Choose a file to import...',
            onClick: async () => {
              try {
                const result = await IV.api.importEntries(null);
                if (!result) return;
                handle.close();
                await IV.app.refresh();
                await IV.app.autoSave();
                toast(result.added + ' entries imported', 'good');
              } catch (err) {
                toast(err.message, 'error');
              }
            }
          })
        ),
        h('div', { class: 'detail-section' }, h('h3', { text: 'Export' })),
        h('p', {
          class: 'error-line',
          text: 'Exports are not encrypted. Every password is written in plain text, so delete the file when you are done with it.'
        }),
        h(
          'div',
          { class: 'row-gap' },
          h('button', {
            class: 'btn ghost small',
            text: 'Export as CSV...',
            onClick: () => runExport('csv')
          }),
          h('button', {
            class: 'btn ghost small',
            text: 'Export as KeePass XML...',
            onClick: () => runExport('xml')
          })
        )
      ),
      footer: [h('button', { class: 'btn primary', text: 'Done', onClick: () => handle.close() })]
    });

    async function runExport(format) {
      const ok = await IV.api.confirm({
        title: 'Export unencrypted',
        message: 'Write every entry, including passwords, to a plain file?',
        detail: 'Anyone who can read that file can read your passwords.',
        confirmLabel: 'Export anyway',
        destructive: true
      });
      if (!ok) return;
      try {
        const result = await IV.api.exportEntries(format);
        if (result) toast('Exported to ' + result.filePath, 'good');
      } catch (err) {
        toast(err.message, 'error');
      }
    }
  }

  /* ------------------------------------------------------------- backups */

  async function openBackups() {
    let list;
    try {
      list = await IV.api.listBackups();
    } catch (err) {
      toast(err.message, 'error');
      return;
    }

    const rows = h('div');
    if (!list.length) {
      rows.append(h('p', { class: 'empty-note', text: 'No backups yet. One is written every time the database saves.' }));
    }
    for (const backup of list) {
      rows.append(
        h(
          'div',
          { class: 'detail-field' },
          h('div', { class: 'df-label', text: formatRelative(backup.modified) }),
          h('div', { class: 'df-value', text: formatDate(backup.modified) + '  ·  ' + formatSize(backup.size) }),
          h(
            'div',
            { class: 'df-actions' },
            h('button', {
              class: 'btn ghost small',
              text: 'Restore',
              onClick: async () => {
                const ok = await IV.api.confirm({
                  title: 'Restore backup',
                  message: 'Replace the current database with the backup from ' + formatDate(backup.modified) + '?',
                  detail: 'The current contents are backed up first, and the database locks so you can unlock the restored copy.',
                  confirmLabel: 'Restore',
                  destructive: true
                });
                if (!ok) return;
                try {
                  await IV.api.restoreBackup(backup.name);
                  handle.close();
                  toast('Restored, unlock to continue', 'good');
                } catch (err) {
                  toast(err.message, 'error');
                }
              }
            })
          )
        )
      );
    }

    const handle = modal({
      title: 'Backups',
      wide: true,
      body: h(
        'div',
        null,
        h('p', { class: 'hint', text: 'Propolis keeps the most recent saves. Older ones drop off automatically.' }),
        rows
      )
    });
  }

  /* ------------------------------------------------------------ security */

  async function openSecurity() {
    const info = IV.state.info;
    if (!info || !info.open) {
      toast('Unlock a database first', 'error');
      return;
    }

    let status;
    try {
      status = await IV.api.securityStatus(info.filePath);
    } catch (err) {
      toast(err.message, 'error');
      return;
    }

    const body = h('div');

    /* PIN */
    const pinState = h('p', { class: 'hint' });
    const refreshPin = () => {
      pinState.textContent = status.hasPin
        ? 'A PIN is set. It unlocks this database on this Windows account.'
        : 'No PIN set.';
    };
    refreshPin();

    body.append(
      h('div', { class: 'detail-section' }, h('h3', { text: 'PIN unlock' })),
      pinState,
      h(
        'div',
        { class: 'row-gap' },
        h('button', {
          class: 'btn ghost small',
          text: status.hasPin ? 'Change PIN' : 'Set a PIN',
          onClick: () => askForPin('pin')
        }),
        status.hasPin
          ? h('button', {
              class: 'btn danger small',
              text: 'Remove PIN',
              onClick: async () => {
                await IV.api.clearPin(info.filePath);
                status.hasPin = false;
                refreshPin();
                toast('PIN removed');
              }
            })
          : null
      ),
      h('p', {
        class: 'hint',
        text:
          'The master password is encrypted with a key derived from the PIN, then wrapped by Windows. ' +
          'Both the PIN and this Windows account are needed to unlock.'
      })
    );

    /* Windows Hello */
    const helloState = h('p', { class: 'hint' });
    const refreshHello = () => {
      helloState.textContent = !status.helloAvailable
        ? 'Windows Hello is not available: ' + (status.helloReason || 'unknown reason')
        : status.helloEnabled
          ? 'Windows Hello unlock is on for this database.'
          : 'Windows Hello unlock is off.';
    };
    refreshHello();

    body.append(
      h('div', { class: 'detail-section' }, h('h3', { text: 'Windows Hello' })),
      helloState,
      h(
        'div',
        { class: 'row-gap' },
        h('button', {
          class: 'btn ghost small',
          text: status.helloEnabled ? 'Turn off' : 'Turn on',
          disabled: !status.helloAvailable,
          onClick: async () => {
            if (status.helloEnabled) {
              await IV.api.setHello({ filePath: info.filePath, enabled: false });
              status.helloEnabled = false;
              refreshHello();
              toast('Windows Hello unlock turned off');
              return;
            }
            const password = await askMasterPassword('Confirm your master password to turn on Windows Hello');
            if (password === null) return;
            try {
              await IV.api.setHello({ filePath: info.filePath, enabled: true, password });
              status.helloEnabled = true;
              refreshHello();
              toast('Windows Hello unlock turned on', 'good');
            } catch (err) {
              toast(err.message, 'error');
            }
          }
        })
      )
    );

    /* duress */
    const duressState = h('p', { class: 'hint' });
    const refreshDuress = () => {
      duressState.textContent = status.hasDuress
        ? 'A duress PIN is set. Entering it will ' +
          (status.duressAction === 'wipe' ? 'delete this database and its backups.' : 'open the decoy database instead.')
        : 'No duress PIN set.';
    };
    refreshDuress();

    body.append(
      h('div', { class: 'detail-section' }, h('h3', { class: 'with-help' }, 'Duress PIN', IV.glossary.badge('duress'))),
      duressState,
      h(
        'div',
        { class: 'row-gap' },
        h('button', {
          class: 'btn ghost small',
          text: status.hasDuress ? 'Change duress PIN' : 'Set a duress PIN',
          onClick: () => askForPin('duress')
        }),
        status.hasDuress
          ? h('button', {
              class: 'btn danger small',
              text: 'Remove',
              onClick: async () => {
                await IV.api.clearDuress(info.filePath);
                status.hasDuress = false;
                refreshDuress();
                toast('Duress PIN removed');
              }
            })
          : null
      )
    );

    /* YubiKey */
    const yubiState = h('p', { class: 'hint' });
    const yubiActions = h('div', { class: 'row-gap' });
    const slotSelect = h(
      'select',
      null,
      h('option', { value: '1', text: 'Slot 1' }),
      h('option', { value: '2', selected: true, text: 'Slot 2 (usual choice)' })
    );

    async function refreshYubi() {
      const [detected, configured] = await Promise.all([
        IV.api.yubikeyDetect(),
        IV.api.yubikeyGet(info.filePath)
      ]);
      if (configured) slotSelect.value = String(configured.slot);

      yubiState.textContent = configured
        ? 'This database needs a YubiKey in slot ' + configured.slot + '. ' + detected.message
        : detected.message;

      IV.dom.clear(yubiActions);
      yubiActions.append(
        h('button', {
          class: 'btn ghost small',
          text: 'Test this key',
          onClick: async () => {
            yubiState.textContent = 'Touch the key if it blinks...';
            try {
              const result = await IV.api.yubikeyTest(Number(slotSelect.value));
              yubiState.textContent =
                'It answered ' + result.bytes + ' bytes in ' + result.tookMs + ' ms. Slot ' + result.slot + ' works.';
            } catch (err) {
              yubiState.textContent = err.message;
            }
          }
        }),
        h('button', {
          class: 'btn ' + (configured ? 'danger' : 'primary') + ' small',
          text: configured ? 'Stop using a YubiKey' : 'Require a YubiKey',
          onClick: async () => {
            if (configured) {
              const ok = await IV.api.confirm({
                title: 'Stop using a YubiKey',
                message: 'Stop requiring a YubiKey for this database?',
                detail: 'The master key is rewritten without the challenge answer in it.',
                confirmLabel: 'Stop using it',
                destructive: true
              });
              if (!ok) return;
              try {
                await IV.api.changeCredentials({ password: await askMasterPassword('Confirm your master password') });
                await IV.api.yubikeySet({ filePath: info.filePath, enabled: false });
                await refreshYubi();
                toast('YubiKey no longer required', 'good');
              } catch (err) {
                toast(err.message, 'error');
              }
              return;
            }

            const ok = await IV.api.confirm({
              title: 'Require a YubiKey',
              message: 'Bind this database to the YubiKey in slot ' + slotSelect.value + '?',
              detail:
                'From then on the database will not open without that key plugged in. If you lose it, and have ' +
                'no backup of the database, the contents are gone. Test the key first, and keep a backup. ' +
                'This feature is still a beta and has not been tested against real hardware.',
              confirmLabel: 'Bind it',
              destructive: true
            });
            if (!ok) return;

            const password = await askMasterPassword('Confirm your master password');
            if (password === null) return;
            try {
              await IV.api.yubikeySet({ filePath: info.filePath, slot: Number(slotSelect.value), enabled: true });
              await IV.api.changeCredentials({
                password,
                yubikey: { slot: Number(slotSelect.value) }
              });
              await refreshYubi();
              toast('This database now needs the YubiKey', 'good');
            } catch (err) {
              await IV.api.yubikeySet({ filePath: info.filePath, enabled: false });
              toast(err.message, 'error');
            }
          }
        })
      );
    }

    // Off unless opted in. A database already bound to a key still shows the
    // section whatever the setting says, or turning it off would leave somebody
    // with no way to unbind and no way in.
    const yubiOptedIn = IV.state.prefs.yubikeyBeta === true;
    const yubiAlreadyBound = Boolean(await IV.api.yubikeyGet(info.filePath).catch(() => null));

    if (yubiOptedIn || yubiAlreadyBound) {
      body.append(
        h('div', { class: 'detail-section' }, h('h3', { text: 'YubiKey' })),
        h(
          'p',
          { class: 'error-line' },
          h('strong', { text: 'Beta, and compatibility is not guaranteed. ' }),
          h('span', {
            text:
              'This has never been run against a real key. Press Test below before ' +
              'binding anything, and back up the database first. If a binding half ' +
              'succeeds, or the key is lost, the contents cannot be recovered.'
          })
        ),
        !yubiOptedIn
          ? h('p', {
              class: 'hint',
              text:
                'YubiKey support is switched off in Settings, but this database is ' +
                'already bound to a key, so the controls stay here.'
            })
          : null,
        yubiState,
        field('Slot', slotSelect),
        yubiActions
      );
      refreshYubi();
    }

    /* failed attempts */
    const failInput = h('input', {
      type: 'number',
      min: '0',
      max: '50',
      value: String(status.wipeAfterFails || 0),
      onChange: async () => {
        const count = Number(failInput.value) || 0;
        if (count > 0) {
          const ok = await IV.api.confirm({
            title: 'Delete after failed attempts',
            message: 'Delete this database after ' + count + ' wrong passwords in a row?',
            detail: 'There is no undo and no recovery. Only turn this on if you keep a backup elsewhere.',
            confirmLabel: 'Turn on',
            destructive: true
          });
          if (!ok) {
            failInput.value = String(status.wipeAfterFails || 0);
            return;
          }
        }
        await IV.api.setWipeAfterFails(info.filePath, count);
        status.wipeAfterFails = count;
        toast(count ? 'Set to ' + count + ' attempts' : 'Turned off');
      }
    });

    body.append(
      h('div', { class: 'detail-section' }, h('h3', { text: 'App lock' })),
      field('Delete everything after this many failed unlocks', failInput, '0 turns it off.')
    );

    const handle = modal({
      title: 'Security and unlock',
      wide: true,
      body,
      footer: [h('button', { class: 'btn primary', text: 'Done', onClick: () => handle.close() })]
    });

    function askMasterPassword(title) {
      return new Promise((resolve) => {
        const input = h('input', { type: 'password', autocomplete: 'off' });
        let settled = false;
        const inner = modal({
          title,
          body: field('Master password', input),
          footer: [
            h('button', { class: 'btn ghost', text: 'Cancel', onClick: () => inner.close() }),
            h('button', {
              class: 'btn primary',
              text: 'Confirm',
              onClick: () => {
                settled = true;
                const value = input.value;
                inner.close();
                resolve(value);
              }
            })
          ],
          onClose: () => {
            if (!settled) resolve(null);
          }
        });
      });
    }

    function askForPin(kind) {
      const pin1 = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', maxlength: '16' });
      const pin2 = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', maxlength: '16' });
      const actionSelect = h(
        'select',
        null,
        h('option', { value: 'dummy', text: 'Open a decoy database instead' }),
        h('option', { value: 'wipe', text: 'Delete this database and its backups' })
      );
      const dummyPath = h('input', { type: 'text', readOnly: true, value: status.duressDummyPath || '', placeholder: 'None' });

      const duressExtras = h(
        'div',
        null,
        field('What should happen', actionSelect),
        field(
          'Decoy database',
          h(
            'div',
            { class: 'row-gap' },
            dummyPath,
            h('button', {
              class: 'btn ghost small',
              text: 'Choose',
              onClick: async () => {
                const picked = await IV.api.chooseDummy();
                if (picked) dummyPath.value = picked;
              }
            })
          )
        )
      );

      const inner = modal({
        title: kind === 'duress' ? 'Duress PIN' : 'Unlock PIN',
        body: h(
          'div',
          null,
          field('PIN (4 to 16 digits)', pin1),
          field('Repeat PIN', pin2),
          kind === 'duress' ? duressExtras : null,
          kind === 'pin'
            ? h('p', { class: 'hint', text: 'You will still be able to unlock with the master password.' })
            : h('p', {
                class: 'error-line',
                text: 'A duress PIN is meant to be entered under pressure. Test it before you rely on it.'
              })
        ),
        footer: [
          h('button', { class: 'btn ghost', text: 'Cancel', onClick: () => inner.close() }),
          h('button', {
            class: 'btn primary',
            text: 'Save',
            onClick: async () => {
              if (pin1.value !== pin2.value) {
                toast('The two PINs do not match', 'error');
                return;
              }
              try {
                if (kind === 'duress') {
                  if (actionSelect.value === 'wipe') {
                    const ok = await IV.api.confirm({
                      title: 'Duress PIN that deletes',
                      message: 'Entering this PIN will permanently delete the database and every backup.',
                      detail: 'There is no undo. Keep a copy somewhere else first.',
                      confirmLabel: 'I understand',
                      destructive: true
                    });
                    if (!ok) return;
                  }
                  await IV.api.setDuress({
                    filePath: info.filePath,
                    pin: pin1.value,
                    action: actionSelect.value,
                    dummyPath: dummyPath.value || null
                  });
                  status.hasDuress = true;
                  status.duressAction = actionSelect.value;
                  refreshDuress();
                } else {
                  const password = await askMasterPassword('Confirm your master password to set a PIN');
                  if (password === null) return;
                  await IV.api.setPin({ filePath: info.filePath, pin: pin1.value, password });
                  status.hasPin = true;
                  refreshPin();
                }
                inner.close();
                toast('Saved', 'good');
              } catch (err) {
                toast(err.message, 'error');
              }
            }
          })
        ]
      });
    }
  }

  /* -------------------------------------------------------- remote storage */

  async function openRemote() {
    const info = IV.state.info;
    if (!info || !info.open) {
      toast('Unlock a database first', 'error');
      return;
    }

    const existing = (await IV.api.remoteGet(info.filePath)) || {};
    const provider = h(
      'select',
      { onChange: () => refresh() },
      h('option', { value: '', selected: !existing.provider, text: 'None (local file only)' }),
      h('option', { value: 'webdav', selected: existing.provider === 'webdav', text: 'WebDAV (Nextcloud, ownCloud, NAS)' }),
      h('option', { value: 'sftp', selected: existing.provider === 'sftp', text: 'SFTP' })
    );

    const url = h('input', { type: 'text', value: existing.url || '', placeholder: 'https://cloud.example.com/remote.php/dav/files/me/Passwords.kdbx' });
    const host = h('input', { type: 'text', value: existing.host || '', placeholder: 'sftp.example.com' });
    const port = h('input', { type: 'number', value: String(existing.port || 22), min: '1', max: '65535' });
    const username = h('input', { type: 'text', value: existing.username || '', spellcheck: 'false' });
    const password = h('input', { type: 'password', placeholder: existing.hasPassword ? 'unchanged' : '' });
    const remotePath = h('input', { type: 'text', value: existing.remotePath || '', placeholder: '/home/me/Passwords.kdbx' });
    const keyPath = h('input', { type: 'text', readOnly: true, value: existing.privateKeyPath || '', placeholder: 'None' });
    const passphrase = h('input', { type: 'password', placeholder: existing.hasPassphrase ? 'unchanged' : '' });

    const webdavFields = h('div', null, field('File URL', url), field('Username', username), field('Password', password));
    const sftpFields = h(
      'div',
      null,
      field('Host', host),
      field('Port', port),
      field('Username', username.cloneNode(true)),
      field('Remote path', remotePath),
      field(
        'Private key (optional)',
        h(
          'div',
          { class: 'row-gap' },
          keyPath,
          h('button', {
            class: 'btn ghost small',
            text: 'Choose',
            onClick: async () => {
              const picked = await IV.api.chooseSshKey();
              if (picked) keyPath.value = picked;
            }
          }),
          h('button', { class: 'btn ghost small', text: 'Clear', onClick: () => (keyPath.value = '') })
        )
      ),
      field('Key passphrase or account password', passphrase)
    );

    const status = h('p', { class: 'update-status' });

    function refresh() {
      webdavFields.hidden = provider.value !== 'webdav';
      sftpFields.hidden = provider.value !== 'sftp';
      status.textContent = existing.lastSyncedAt
        ? 'Last synced ' + formatRelative(existing.lastSyncedAt)
        : provider.value
          ? 'Never synced.'
          : 'This database is a local file.';
    }

    function collect() {
      if (!provider.value) return null;
      if (provider.value === 'webdav') {
        return {
          provider: 'webdav',
          url: url.value.trim(),
          username: username.value.trim(),
          ...(password.value ? { password: password.value } : {})
        };
      }
      return {
        provider: 'sftp',
        host: host.value.trim(),
        port: Number(port.value) || 22,
        username: sftpFields.querySelector('input').value.trim() || username.value.trim(),
        remotePath: remotePath.value.trim(),
        privateKeyPath: keyPath.value || '',
        ...(passphrase.value ? (keyPath.value ? { passphrase: passphrase.value } : { password: passphrase.value }) : {})
      };
    }

    const handle = modal({
      title: 'Remote storage',
      wide: true,
      body: h(
        'div',
        null,
        status,
        h(
          'div',
          { class: 'field' },
          IV.glossary.label('Where this database lives', 'remote'),
          provider
        ),
        webdavFields,
        sftpFields,
        h('p', {
          class: 'hint',
          text:
            'Propolis keeps working on the local copy when the remote is unreachable, and merges the two the next ' +
            'time a sync succeeds. Credentials are encrypted with Windows DPAPI.'
        })
      ),
      footer: [
        h('button', {
          class: 'btn ghost',
          text: 'Test connection',
          onClick: async () => {
            const config = collect();
            if (!config) {
              toast('Pick a provider first', 'error');
              return;
            }
            status.textContent = 'Testing...';
            try {
              const result = await IV.api.remoteTest(config);
              status.textContent = result.exists
                ? 'Connected. The remote file is ' + formatSize(result.size) + '.'
                : 'Connected. No file there yet, the first sync will create it.';
              status.className = 'update-status';
            } catch (err) {
              status.textContent = err.message;
              status.className = 'update-status error-line';
            }
          }
        }),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn ghost', text: 'Cancel', onClick: () => handle.close() }),
        h('button', {
          class: 'btn primary',
          text: 'Save',
          onClick: async () => {
            try {
              await IV.api.remoteSet(info.filePath, collect());
              handle.close();
              toast('Remote storage saved', 'good');
            } catch (err) {
              toast(err.message, 'error');
            }
          }
        })
      ]
    });

    refresh();
  }

  async function syncNow() {
    toast('Syncing...');
    try {
      const result = await IV.api.remoteSync();
      await IV.app.refresh();
      toast(result.merged ? 'Synced, ' + result.merged + ' entries merged in' : 'Synced', 'good');
    } catch (err) {
      if (err.code === 'OFFLINE') {
        toast('Offline, your changes stay local until the next sync', 'error');
      } else {
        toast(err.message, 'error');
      }
    }
  }

  /* ----------------------------------------------------------- SSH agent */

  async function openSsh() {
    let status;
    try {
      status = await IV.api.sshStatus();
    } catch (err) {
      toast(err.message, 'error');
      return;
    }

    const state = h('p', { class: 'update-status' });
    const keyList = h('div');
    const actions = h('div', { class: 'row-gap' });

    function render() {
      state.textContent = status.running
        ? status.keys.length + ' key' + (status.keys.length === 1 ? '' : 's') + ' loaded and serving.'
        : 'The agent is not running.';

      clear(keyList);
      for (const key of status.keys || []) {
        keyList.append(
          h(
            'div',
            { class: 'detail-field' },
            h('div', { class: 'df-label', text: key.algorithm }),
            h('div', { class: 'df-value mono', text: key.comment + '  ·  ' + key.fingerprint })
          )
        );
      }
      if (status.running && !(status.keys || []).length) {
        keyList.append(
          h('p', {
            class: 'hint',
            text: 'No keys found. Add a private key to an entry, either as an attachment or in a custom field named "SSH Key".'
          })
        );
      }

      clear(actions);
      actions.append(
        h('button', {
          class: 'btn ' + (status.running ? 'danger' : 'primary') + ' small',
          text: status.running ? 'Stop agent' : 'Start agent',
          onClick: async () => {
            try {
              status = status.running ? await IV.api.sshStop() : await IV.api.sshStart();
              if (status.running) status = await IV.api.sshStatus();
              render();
            } catch (err) {
              toast(err.message, 'error');
            }
          }
        })
      );
      if (status.running) {
        actions.append(
          h('button', {
            class: 'btn ghost small',
            text: 'Reload keys',
            onClick: async () => {
              status = await IV.api.sshReload();
              render();
              toast('Keys reloaded');
            }
          }),
          h('button', {
            class: 'btn ghost small',
            text: 'Copy the SSH_AUTH_SOCK line',
            onClick: async () => {
              await IV.api.copy("$env:SSH_AUTH_SOCK = '" + status.pipe + "'");
              toast('Copied, paste it into PowerShell');
            }
          })
        );
      }
    }

    render();

    modal({
      title: 'SSH agent',
      wide: true,
      body: h(
        'div',
        null,
        state,
        actions,
        h('div', { class: 'detail-section' }, h('h3', { text: 'Keys' })),
        keyList,
        h('div', { class: 'detail-section' }, h('h3', { class: 'with-help' }, 'How to use it', IV.glossary.badge('sshagent'))),
        h('p', {
          class: 'hint',
          text:
            'Start the agent, then in PowerShell run the SSH_AUTH_SOCK line above before using ssh or git. ' +
            'Keys are read from the open database and never written to disk.'
        })
      )
    });
  }

  /* ------------------------------------------------------------ auto-type */

  function openAutoTypeSettings(entry) {
    const sequence = h('input', {
      type: 'text',
      value: entry.autoTypeSequence || '',
      placeholder: '{USERNAME}{TAB}{PASSWORD}{ENTER}',
      spellcheck: 'false'
    });
    const window = h('input', { type: 'text', value: '', placeholder: 'e.g. *GitHub*', spellcheck: 'false' });

    const handle = modal({
      title: 'Auto-type for ' + (entry.title || 'this entry'),
      body: h(
        'div',
        null,
        h(
          'div',
          { class: 'field' },
          IV.glossary.label('Sequence', 'placeholders'),
          sequence,
          h('p', { class: 'hint', text: 'Leave empty to use {USERNAME}{TAB}{PASSWORD}{ENTER}.' })
        ),
        field('Window title contains', window, 'Optional. Helps Propolis pick this entry over a similar one.'),
        h('p', {
          class: 'hint',
          text: 'Placeholders: {USERNAME} {PASSWORD} {URL} {TITLE} {NOTES} {TOTP} {TAB} {ENTER} {DELAY 500}'
        })
      ),
      footer: [
        h('button', { class: 'btn ghost', text: 'Cancel', onClick: () => handle.close() }),
        h('button', {
          class: 'btn primary',
          text: 'Save',
          onClick: async () => {
            try {
              await IV.api.setAutoTypeSequence({
                id: entry.id,
                sequence: sequence.value.trim(),
                window: window.value.trim()
              });
              handle.close();
              await IV.app.refresh({ selectEntryId: entry.id });
              await IV.app.autoSave();
              toast('Auto-type saved', 'good');
            } catch (err) {
              toast(err.message, 'error');
            }
          }
        })
      ]
    });
  }

  /* ---------------------------------------------------------- TOTP editor */

  function openTotpEditor(entry) {
    const uri = h('input', { type: 'text', placeholder: 'otpauth://totp/...', spellcheck: 'false' });
    const secret = h('input', { type: 'text', placeholder: 'JBSWY3DPEHPK3PXP', spellcheck: 'false' });
    const digits = h('input', { type: 'number', value: '6', min: '5', max: '8' });
    const period = h('input', { type: 'number', value: '30', min: '10', max: '120' });
    const algorithm = h(
      'select',
      null,
      h('option', { value: 'sha1', text: 'SHA-1 (default)' }),
      h('option', { value: 'sha256', text: 'SHA-256' }),
      h('option', { value: 'sha512', text: 'SHA-512' })
    );
    const steam = h('input', { type: 'checkbox' });

    const handle = modal({
      title: entry.totp ? 'Change one time code' : 'Add a one time code',
      body: h(
        'div',
        null,
        h(
          'div',
          { class: 'field' },
          IV.glossary.label('Paste an otpauth:// address', 'totp'),
          uri,
          h('p', { class: 'hint', text: 'This is what a QR code contains. Everything below is filled in from it.' })
        ),
        h('div', { class: 'detail-section' }, h('h3', { text: 'Or enter the secret by hand' })),
        field('Secret', secret),
        h('div', { class: 'gen-grid' }, field('Digits', digits), field('Period (seconds)', period)),
        field('Algorithm', algorithm),
        h('label', { class: 'checkline' }, steam, h('span', { text: 'Steam authenticator (5 characters)' }))
      ),
      footer: [
        entry.totp
          ? h('button', {
              class: 'btn danger',
              text: 'Remove',
              onClick: async () => {
                const ok = await IV.api.confirm({
                  title: 'Remove one time code',
                  message: 'Remove the one time code from this entry?',
                  confirmLabel: 'Remove',
                  destructive: true
                });
                if (!ok) return;
                await IV.api.removeTotp(entry.id);
                handle.close();
                await IV.app.refresh({ selectEntryId: entry.id });
                await IV.app.autoSave();
                toast('One time code removed');
              }
            })
          : null,
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn ghost', text: 'Cancel', onClick: () => handle.close() }),
        h('button', {
          class: 'btn primary',
          text: 'Save',
          onClick: async () => {
            try {
              await IV.api.setTotp({
                id: entry.id,
                uri: uri.value.trim(),
                secret: secret.value.trim(),
                digits: Number(digits.value),
                period: Number(period.value),
                algorithm: algorithm.value,
                steam: steam.checked
              });
              handle.close();
              await IV.app.refresh({ selectEntryId: entry.id });
              await IV.app.autoSave();
              toast('One time code saved', 'good');
            } catch (err) {
              toast(err.message, 'error');
            }
          }
        })
      ].filter(Boolean)
    });
  }

  async function showTotpQr(entry) {
    try {
      const result = await IV.api.totpQr(entry.id);
      modal({
        title: 'One time code for ' + (entry.title || 'this entry'),
        body: h(
          'div',
          { class: 'qr-wrap' },
          h('img', { class: 'qr-image', src: result.svg, alt: 'QR code' }),
          h('p', { class: 'hint', text: 'Scan this with another authenticator app to add the same code there.' }),
          h('button', {
            class: 'btn ghost small',
            text: 'Copy the otpauth address',
            onClick: async () => {
              await IV.api.copy(result.uri);
              toast('Copied');
            }
          })
        )
      });
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  IV.tools = {
    openCompare,
    openPwned,
    openSimilar,
    openFavicons,
    openTransfer,
    openBackups,
    openSecurity,
    openRemote,
    syncNow,
    openSsh,
    openAutoTypeSettings,
    openTotpEditor,
    showTotpQr,
    askCredentials
  };
})(window.IV);
