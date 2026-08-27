/* The right hand pane: one entry, its fields, its one time code, its history. */
window.IV = window.IV || {};

(function (IV) {
  'use strict';

  const { h, $, clear, toast, modal } = IV.dom;

  let totpTimer = null;

  function stopTimers() {
    if (totpTimer) {
      clearInterval(totpTimer);
      totpTimer = null;
    }
  }

  function copyButton(title, getText) {
    return h('button', {
      class: 'icon-btn copy',
      title,
      onClick: async () => {
        try {
          const result = await getText();
          if (result && result.clearAfter) {
            toast(title.replace('Copy ', 'Copied ') + ' · clears in ' + result.clearAfter + 's');
          } else {
            toast(title.replace('Copy ', 'Copied '));
          }
        } catch (err) {
          toast(err.message, 'error');
        }
      }
    });
  }

  function field(label, value, options = {}) {
    const valueNode = h('div', { class: 'df-value' + (options.mono ? ' mono' : '') , text: value });
    const actions = h('div', { class: 'df-actions' });
    const row = h('div', { class: 'detail-field' }, h('div', { class: 'df-label', text: label }), valueNode, actions);
    return { row, valueNode, actions };
  }

  function renderPasswordField(entry) {
    const concealed = IV.state.prefs.concealPasswords !== false;
    let revealed = false;
    let cached = null;

    const { row, valueNode, actions } = field('Password', '••••••••••••', { mono: true });

    const revealBtn = h('button', {
      class: 'icon-btn reveal',
      title: 'Show password',
      onClick: async () => {
        revealed = !revealed;
        revealBtn.classList.toggle('on', revealed);
        if (revealed) {
          if (cached === null) cached = await IV.api.secret(entry.id, 'Password');
          valueNode.textContent = cached || '(empty)';
        } else {
          valueNode.textContent = '••••••••••••';
        }
      }
    });

    if (!concealed) revealBtn.click();

    actions.append(revealBtn, copyButton('Copy password', () => IV.api.copyField(entry.id, 'Password')));

    if (entry.passwordStrength) {
      const meter = IV.dom.strengthMeter(entry.passwordStrength);
      return h('div', null, row, h('div', { class: 'strength-holder' }, meter));
    }
    return row;
  }

  function renderTotp(entry) {
    const codeNode = h('div', { class: 'totp-code', text: '------' });
    const ring = h('div', { class: 'totp-ring' }, h('span', { text: '' }));
    const box = h(
      'div',
      { class: 'totp-box' },
      ring,
      h('div', { class: 'totp-holder' }, codeNode, h('div', { class: 'db-sub', text: entry.totp.issuer || 'One time code' })),
      h('div', { class: 'spacer' }),
      copyButton('Copy code', () => IV.api.copyTotp(entry.id))
    );
    box.style.setProperty('justify-content', 'flex-start');

    async function tick() {
      try {
        const result = await IV.api.totp(entry.id);
        if (!result || result.error) {
          codeNode.textContent = 'invalid';
          return;
        }
        const spaced = result.code.length === 6 ? result.code.slice(0, 3) + ' ' + result.code.slice(3) : result.code;
        codeNode.textContent = spaced;
        const pct = Math.round((result.secondsLeft / result.period) * 100);
        ring.style.setProperty('--pct', String(pct));
        ring.firstChild.textContent = String(result.secondsLeft);
        box.classList.toggle('expiring', result.secondsLeft <= 5);
      } catch {
        codeNode.textContent = 'error';
      }
    }

    tick();
    totpTimer = setInterval(tick, 1000);
    return box;
  }

  function renderAttachments(entry) {
    const list = h('div');
    for (const attachment of entry.attachments) {
      const { row, actions } = field(IV.dom.formatSize(attachment.size), attachment.name);
      actions.append(
        h('button', {
          class: 'btn ghost small',
          text: 'Save as...',
          onClick: async () => {
            try {
              const result = await IV.api.saveAttachment(entry.id, attachment.name);
              if (result) toast('Saved to ' + result.path, 'good');
            } catch (err) {
              toast(err.message, 'error');
            }
          }
        }),
        h('button', {
          class: 'icon-btn trash',
          title: 'Remove attachment',
          onClick: async () => {
            const ok = await IV.api.confirm({
              title: 'Remove attachment',
              message: 'Remove ' + attachment.name + ' from this entry?',
              confirmLabel: 'Remove',
              destructive: true
            });
            if (!ok) return;
            await IV.api.removeAttachment(entry.id, attachment.name);
            await IV.app.refresh({ selectEntryId: entry.id });
            await IV.app.autoSave();
          }
        })
      );
      list.append(row);
    }
    list.append(
      h('button', {
        class: 'btn ghost small',
        text: 'Attach file...',
        onClick: async () => {
          try {
            const updated = await IV.api.addAttachment(entry.id);
            if (!updated) return;
            await IV.app.refresh({ selectEntryId: entry.id });
            await IV.app.autoSave();
            toast('Attached', 'good');
          } catch (err) {
            toast(err.message, 'error');
          }
        }
      })
    );
    return list;
  }

  function openHistory(entry) {
    const list = h('div');
    for (const item of entry.history) {
      list.append(
        h(
          'div',
          { class: 'detail-field' },
          h('div', { class: 'df-label', text: IV.dom.formatRelative(item.modified) }),
          h('div', { class: 'df-value', text: (item.title || '(no title)') + (item.username ? ' · ' + item.username : '') }),
          h(
            'div',
            { class: 'df-actions' },
            h('button', {
              class: 'btn ghost small',
              text: 'View',
              onClick: async () => {
                const snapshot = await IV.api.historyEntry(entry.id, item.index);
                const secret = '(stored, restore to reveal)';
                modal({
                  title: 'Version from ' + IV.dom.formatDate(item.modified),
                  body: h(
                    'div',
                    null,
                    field('Title', snapshot.title).row,
                    field('Username', snapshot.username).row,
                    field('Password', secret).row,
                    field('URL', snapshot.url).row,
                    snapshot.notes ? h('div', { class: 'notes-box', text: snapshot.notes }) : null
                  )
                });
              }
            }),
            h('button', {
              class: 'btn ghost small',
              text: 'Restore',
              onClick: async () => {
                const ok = await IV.api.confirm({
                  title: 'Restore version',
                  message: 'Restore this entry to the version from ' + IV.dom.formatDate(item.modified) + '?',
                  detail: 'The current values are kept in history.',
                  confirmLabel: 'Restore'
                });
                if (!ok) return;
                await IV.api.restoreHistory(entry.id, item.index);
                handle.close();
                await IV.app.refresh({ selectEntryId: entry.id });
                await IV.app.autoSave();
                toast('Version restored', 'good');
              }
            })
          )
        )
      );
    }

    const handle = modal({
      title: 'History (' + entry.history.length + ')',
      wide: true,
      body: entry.history.length ? list : h('p', { class: 'empty-note', text: 'No earlier versions yet.' })
    });
  }

  /* ------------------------------------------------------------------ render */

  function render(entry) {
    stopTimers();
    const detail = $('#detail');
    const empty = $('#detail-empty');
    if (!entry) {
      detail.hidden = true;
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    detail.hidden = false;
    clear(detail);

    const isFavorite = (entry.tags || []).some((t) => /^favou?rite$/i.test(t));

    const head = h(
      'div',
      { class: 'detail-head' },
      IV.dom.avatar(entry),
      h(
        'div',
        { class: 'detail-titles' },
        h('h1', { text: entry.title || '(no title)' }),
        h('div', { class: 'detail-group', text: entry.groupName || '' })
      ),
      h(
        'div',
        { class: 'detail-tools' },
        h('button', {
          class: 'icon-btn star' + (isFavorite ? ' on' : ''),
          title: isFavorite ? 'Remove from favorites' : 'Add to favorites',
          onClick: async () => {
            await IV.api.toggleFavorite(entry.id);
            await IV.app.refresh({ selectEntryId: entry.id });
            await IV.app.autoSave();
          }
        }),
        h('button', {
          class: 'icon-btn edit',
          title: 'Edit (Ctrl+E)',
          onClick: () => IV.editor.openEntryEditor(entry)
        }),
        h('button', {
          class: 'icon-btn more',
          title: 'More actions',
          onClick: (e) => openMoreMenu(entry, e.currentTarget)
        })
      )
    );
    detail.append(head);

    if (entry.expired) {
      detail.append(h('p', { class: 'error-line', text: 'This entry expired on ' + IV.dom.formatDate(entry.expiryTime) + '.' }));
    }
    if (entry.inRecycleBin) {
      detail.append(
        h(
          'div',
          { class: 'row-gap' },
          h('p', { class: 'error-line', text: 'In the recycle bin.' }),
          h('button', {
            class: 'btn ghost small',
            text: 'Restore',
            onClick: async () => {
              await IV.api.restoreEntry(entry.id, null);
              await IV.app.refresh({ selectEntryId: entry.id });
              await IV.app.autoSave();
              toast('Restored', 'good');
            }
          })
        )
      );
    }

    /* core fields */
    const core = h('div');
    if (entry.username) {
      const f = field('Username', entry.username);
      f.actions.append(copyButton('Copy username', () => IV.api.copyField(entry.id, 'UserName')));
      core.append(f.row);
    }
    core.append(renderPasswordField(entry));
    if (entry.url) {
      const f = field('URL', entry.url);
      f.valueNode.classList.add('link');
      f.valueNode.addEventListener('click', () => IV.api.openUrl(entry.url).catch((err) => toast(err.message, 'error')));
      f.actions.append(
        copyButton('Copy URL', () => IV.api.copyField(entry.id, 'URL')),
        h('button', {
          class: 'icon-btn image',
          title: 'Download this site’s icon',
          onClick: async () => {
            try {
              toast('Fetching icon...');
              const result = await IV.api.favicon(entry.id);
              await IV.app.refresh({ selectEntryId: entry.id });
              await IV.app.autoSave();
              toast('Icon set from ' + new URL(result.source).hostname, 'good');
            } catch (err) {
              toast(err.message, 'error');
            }
          }
        }),
        h('button', {
          class: 'icon-btn link',
          title: 'Open in browser',
          onClick: () => IV.api.openUrl(entry.url).catch((err) => toast(err.message, 'error'))
        })
      );
      core.append(f.row);
    }
    detail.append(core);

    const totpSection = h(
      'div',
      { class: 'detail-section' },
      h(
        'div',
        { class: 'row-gap' },
        h('h3', { text: 'One time code' }),
        h('div', { class: 'spacer' }),
        entry.totp
          ? h('button', {
              class: 'btn ghost small',
              text: 'QR code',
              onClick: () => IV.tools.showTotpQr(entry)
            })
          : null,
        h('button', {
          class: 'icon-btn edit',
          title: entry.totp ? 'Change the one time code' : 'Add a one time code',
          onClick: () => IV.tools.openTotpEditor(entry)
        })
      )
    );
    if (entry.totp) totpSection.append(renderTotp(entry));
    else totpSection.append(h('p', { class: 'hint', text: 'No one time code on this entry yet.' }));
    detail.append(totpSection);

    // Passkeys are stored as the KeePassXC style KPEX_PASSKEY_* fields.
    const passkeyFields = (entry.customFields || []).filter((f) => /^KPEX_PASSKEY_/i.test(f.key));
    if (passkeyFields.length) {
      const relying = passkeyFields.find((f) => /RELYING_PARTY/i.test(f.key));
      const user = passkeyFields.find((f) => /USERNAME/i.test(f.key));
      const wrap = h(
        'div',
        { class: 'detail-section' },
        h('h3', { text: 'Passkey' }),
        field('Site', relying ? relying.value : '(unknown)').row,
        field('Account', user ? user.value : '(unknown)').row,
        h('p', {
          class: 'hint',
          text:
            'Stored and kept safe here, and it travels with the database. Signing in with it needs a browser ' +
            'extension, which Propolis does not have yet.'
        })
      );
      detail.append(wrap);
    }

    if (entry.customFields && entry.customFields.length) {
      const wrap = h('div', { class: 'detail-section' }, h('h3', { text: 'Custom fields' }));
      for (const custom of entry.customFields) {
        if (custom.key === 'otp' || custom.key === 'TOTP Seed' || custom.key === 'TOTP Settings') continue;
        if (/^KPEX_PASSKEY_/i.test(custom.key)) continue;
        const f = field(custom.key, custom.protected ? '••••••••' : custom.value, { mono: custom.protected });
        if (custom.protected) {
          let shown = false;
          f.actions.append(
            h('button', {
              class: 'icon-btn reveal',
              title: 'Show value',
              onClick: async (e) => {
                shown = !shown;
                e.currentTarget.classList.toggle('on', shown);
                f.valueNode.textContent = shown ? await IV.api.secret(entry.id, custom.key) : '••••••••';
              }
            })
          );
        }
        f.actions.append(copyButton('Copy ' + custom.key, () => IV.api.copyField(entry.id, custom.key)));
        wrap.append(f.row);
      }
      if (wrap.childElementCount > 1) detail.append(wrap);
    }

    if (/\{[^{}]+\}/.test(entry.notes || '') || /\{[^{}]+\}/.test(entry.username || '')) {
      const expanded = h('div', { class: 'hint' });
      IV.api
        .expandField(entry.id, entry.notes ? 'Notes' : 'UserName')
        .then((result) => {
          if (result.value !== result.raw) {
            expanded.textContent = 'Placeholders resolve to: ' + result.value;
          }
        })
        .catch(() => {});
      detail.append(expanded);
    }

    if (entry.notes) {
      detail.append(
        h(
          'div',
          { class: 'detail-section' },
          h(
            'div',
            { class: 'row-gap' },
            h('h3', { text: 'Notes' }),
            h('div', { class: 'spacer' }),
            copyButton('Copy notes', () => IV.api.copyField(entry.id, 'Notes'))
          ),
          IV.state.prefs.markdownNotes !== false && IV.markdown.looksLikeMarkdown(entry.notes)
            ? h('div', { class: 'notes-box' }, IV.markdown.render(entry.notes))
            : h('div', { class: 'notes-box', text: entry.notes })
        )
      );
    }

    detail.append(h('div', { class: 'detail-section' }, h('h3', { text: 'Attachments' }), renderAttachments(entry)));

    if (entry.tags && entry.tags.length) {
      detail.append(
        h(
          'div',
          { class: 'detail-section' },
          h('h3', { text: 'Tags' }),
          h('div', { class: 'tag-row' }, entry.tags.map((t) => h('span', { class: 'tag', text: t })))
        )
      );
    }

    const meta = h(
      'div',
      { class: 'meta-grid' },
      h('div', null, h('b', { text: 'Created' }), IV.dom.formatDate(entry.created)),
      h('div', null, h('b', { text: 'Modified' }), IV.dom.formatDate(entry.modified)),
      h('div', null, h('b', { text: 'Accessed' }), IV.dom.formatDate(entry.accessed)),
      h('div', null, h('b', { text: 'Expires' }), entry.expires ? IV.dom.formatDate(entry.expiryTime) : 'Never')
    );
    const metaSection = h('div', { class: 'detail-section' }, h('h3', { text: 'Details' }), meta);
    if (entry.history && entry.history.length) {
      metaSection.append(
        h('button', {
          class: 'btn ghost small',
          text: 'History (' + entry.history.length + ')',
          onClick: () => openHistory(entry)
        })
      );
    }
    detail.append(metaSection);
  }

  function openMoreMenu(entry, anchor) {
    const items = [
      {
        label: 'Duplicate',
        run: async () => {
          const copy = await IV.api.duplicateEntry(entry.id);
          await IV.app.refresh({ selectEntryId: copy.id });
          await IV.app.autoSave();
          toast('Entry duplicated', 'good');
        }
      },
      {
        label: 'Move to group...',
        run: () => openMoveDialog(entry)
      },
      {
        label: 'Auto-type into the front window',
        run: async () => {
          const values = await IV.api.autoTypeNow(null);
          toast('Typed into ' + values.window);
        }
      },
      {
        label: 'Auto-type settings...',
        run: () => IV.tools.openAutoTypeSettings(entry)
      },
      {
        label: 'Remove the custom icon',
        run: async () => {
          await IV.api.clearIcon(entry.id);
          await IV.app.refresh({ selectEntryId: entry.id });
          await IV.app.autoSave();
          toast('Icon removed');
        }
      },
      {
        label: entry.inRecycleBin ? 'Delete permanently' : 'Delete',
        danger: true,
        run: async () => {
          const ok = await IV.api.confirm({
            title: 'Delete entry',
            message: entry.inRecycleBin
              ? 'Permanently delete "' + (entry.title || 'this entry') + '"?'
              : 'Move "' + (entry.title || 'this entry') + '" to the recycle bin?',
            detail: entry.inRecycleBin ? 'This cannot be undone.' : '',
            confirmLabel: 'Delete',
            destructive: true
          });
          if (!ok) return;
          await IV.api.deleteEntry(entry.id, entry.inRecycleBin);
          await IV.app.refresh({ selectEntryId: null });
          await IV.app.autoSave();
          toast('Entry deleted');
        }
      }
    ];

    const menu = h(
      'div',
      { class: 'card' },
      items.map((item) =>
        h('button', {
          class: 'btn ghost' + (item.danger ? ' danger' : ''),
          text: item.label,
          onClick: async () => {
            handle.close();
            try {
              await item.run();
            } catch (err) {
              toast(err.message, 'error');
            }
          }
        })
      )
    );
    menu.style.setProperty('display', 'flex');
    menu.style.setProperty('flex-direction', 'column');
    menu.style.setProperty('gap', '4px');
    menu.style.setProperty('margin', '0');

    const handle = modal({ title: entry.title || 'Entry', body: menu });
  }

  function openMoveDialog(entry) {
    const select = h('select', null, IV.editor.groupOptions(entry.groupId));
    const handle = modal({
      title: 'Move entry',
      body: h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Destination group' }), select),
      footer: [
        h('button', { class: 'btn ghost', text: 'Cancel', onClick: () => handle.close() }),
        h('button', {
          class: 'btn primary',
          text: 'Move',
          onClick: async () => {
            try {
              await IV.api.moveEntry(entry.id, select.value);
              handle.close();
              await IV.app.refresh({ selectEntryId: entry.id });
              await IV.app.autoSave();
              toast('Entry moved', 'good');
            } catch (err) {
              toast(err.message, 'error');
            }
          }
        })
      ]
    });
  }

  IV.detail = { render, stopTimers };
})(window.IV);
