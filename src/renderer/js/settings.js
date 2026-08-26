/* Settings, database properties, shortcuts, and about. */
window.IV = window.IV || {};

(function (IV) {
  'use strict';

  const { h, modal, toast } = IV.dom;

  function numberField(label, value, min, max, suffix, onChange) {
    const input = h('input', {
      type: 'number',
      min: String(min),
      max: String(max),
      value: String(value),
      onChange: () => onChange(Number(input.value))
    });
    return h(
      'label',
      { class: 'field' },
      h('span', { class: 'field-label', text: label }),
      h('span', { class: 'input-with-action' }, input, suffix ? h('span', { class: 'db-sub', text: suffix }) : null)
    );
  }

  function toggle(label, checked, onChange) {
    const input = h('input', { type: 'checkbox', checked, onChange: () => onChange(input.checked) });
    return h('label', { class: 'checkline' }, input, h('span', { text: label }));
  }

  /** A text box rather than a key capture: Electron accelerators are text. */
  function hotkeyField(prefs) {
    const input = h('input', {
      type: 'text',
      value: prefs.autoTypeHotkey || '',
      placeholder: 'Control+Alt+A',
      spellcheck: 'false',
      onChange: async () => {
        try {
          await apply({ autoTypeHotkey: input.value.trim() });
          toast(input.value.trim() ? 'Auto-type hotkey set' : 'Auto-type hotkey turned off', 'good');
        } catch (err) {
          toast(err.message, 'error');
        }
      }
    });
    return h(
      'label',
      { class: 'field' },
      h('span', { class: 'field-label', text: 'Auto-type hotkey' }),
      input,
      h('p', { class: 'hint', text: 'Press this anywhere in Windows to type into the front window. Empty turns it off.' })
    );
  }

  function appIconField(prefs) {
    const select = h('select', {
      onChange: async () => {
        await apply({ appIcon: select.value });
        toast('App icon changed', 'good');
      }
    });
    IV.api
      .call('app.iconChoices')
      .then((choices) => {
        IV.dom.clear(select);
        for (const choice of choices) {
          select.append(
            h('option', { value: choice.key, selected: choice.key === (prefs.appIcon || 'default'), text: choice.name })
          );
        }
      })
      .catch(() => {});
    return h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'App icon' }), select);
  }

  async function apply(patch) {
    IV.state.prefs = await IV.api.setPrefs(patch);
    IV.app.applyTheme();
  }

  function openSettings() {
    const prefs = IV.state.prefs;
    const info = IV.state.info;

    const general = h(
      'div',
      null,
      numberField('Clear the clipboard after', prefs.clipboardClearSeconds, 0, 600, 'seconds (0 to keep)', (v) =>
        apply({ clipboardClearSeconds: v })
      ),
      numberField('Lock after inactivity', prefs.autoLockMinutes, 0, 240, 'minutes (0 to never)', (v) =>
        apply({ autoLockMinutes: v })
      ),
      toggle('Lock when the window is minimised', prefs.lockOnMinimize, (v) => apply({ lockOnMinimize: v })),
      toggle('Lock when Windows sleeps or locks', prefs.lockOnSuspend, (v) => apply({ lockOnSuspend: v })),
      toggle('Hide passwords until revealed', prefs.concealPasswords !== false, (v) => apply({ concealPasswords: v })),
      toggle('Light theme', prefs.theme === 'light', (v) => apply({ theme: v ? 'light' : 'dark' })),
      toggle('Render notes as Markdown', prefs.markdownNotes !== false, (v) => apply({ markdownNotes: v })),
      numberField('Keep this many backups', prefs.keepBackups, 0, 100, 'saves (0 to keep none)', (v) =>
        apply({ keepBackups: v })
      ),
      numberField(
        'Remind me to change the master password after',
        prefs.masterPasswordReminderDays,
        0,
        1095,
        'days (0 to never)',
        (v) => apply({ masterPasswordReminderDays: v })
      ),
      hotkeyField(prefs),
      appIconField(prefs),
      h(
        'div',
        { class: 'row-gap' },
        h('button', { class: 'btn ghost small', text: 'Updates...', onClick: () => openUpdates() })
      )
    );

    const body = h('div', null, general);

    if (info && info.open) {
      const quickToggle = h('input', {
        type: 'checkbox',
        checked: IV.state.hasQuickUnlock,
        onChange: async () => {
          if (quickToggle.checked) {
            quickToggle.checked = false;
            toast('Tick "remember this password" on the unlock screen to turn this on');
            return;
          }
          await IV.api.setQuickUnlock({ filePath: info.filePath, enabled: false });
          IV.state.hasQuickUnlock = false;
          toast('Stored password removed', 'good');
        }
      });

      body.append(
        h(
          'div',
          { class: 'detail-section' },
          h('h3', { text: 'This database' }),
          h(
            'div',
            { class: 'meta-grid' },
            h('div', null, h('b', { text: 'Name' }), info.name),
            h('div', null, h('b', { text: 'Format' }), 'KDBX ' + info.version),
            h('div', null, h('b', { text: 'Key derivation' }), info.kdf),
            h('div', null, h('b', { text: 'Cipher' }), info.cipher),
            h('div', null, h('b', { text: 'Entries' }), String(info.entryCount)),
            h('div', null, h('b', { text: 'Groups' }), String(info.groupCount))
          ),
          h('p', { class: 'path-line', text: info.filePath }),
          h('label', { class: 'checkline' }, quickToggle, h('span', { text: 'Quick unlock stored on this Windows account' })),
          h(
            'div',
            { class: 'row-gap' },
            h('button', { class: 'btn ghost small', text: 'Change master key', onClick: () => IV.editor.openMasterKeyDialog() }),
            h('button', {
              class: 'btn ghost small',
              text: 'Save a copy...',
              onClick: async () => {
                try {
                  const result = await IV.api.saveAs();
                  if (result) toast('Saved to ' + result.filePath, 'good');
                  await IV.app.refresh();
                } catch (err) {
                  toast(err.message, 'error');
                }
              }
            }),
            h('button', {
              class: 'btn ghost small',
              text: 'Show in Explorer',
              onClick: () => IV.api.revealInFolder(info.filePath)
            })
          ),
          h(
            'div',
            { class: 'row-gap' },
            h('button', {
              class: 'btn danger small',
              text: 'Empty recycle bin',
              onClick: async () => {
                const ok = await IV.api.confirm({
                  title: 'Empty recycle bin',
                  message: 'Permanently delete everything in the recycle bin?',
                  detail: 'This cannot be undone.',
                  confirmLabel: 'Empty',
                  destructive: true
                });
                if (!ok) return;
                const result = await IV.api.emptyRecycleBin();
                await IV.app.refresh();
                await IV.app.autoSave();
                toast(result.removed + ' items removed', 'good');
              }
            })
          )
        )
      );
    }

    const handle = modal({
      title: 'Settings',
      body,
      footer: [h('button', { class: 'btn primary', text: 'Done', onClick: () => handle.close() })]
    });
  }

  /* ------------------------------------------------------------- updates */

  let liveUpdatePanel = null;

  function describe(update) {
    switch (update.status) {
      case 'unconfigured':
        return 'No update source is set, so Ironvault never checks.';
      case 'checking':
        return 'Checking...';
      case 'available':
        return 'Version ' + update.version + ' is available. You have ' + update.currentVersion + '.';
      case 'none':
        return 'You are on the latest version (' + update.currentVersion + ').';
      case 'downloading':
        return 'Downloading... ' + update.percent + '%';
      case 'ready':
        return 'Version ' + update.version + ' is downloaded and ready to install.';
      case 'error':
        return update.error || 'The update check failed.';
      default:
        return 'Version ' + update.currentVersion + '.';
    }
  }

  function openUpdates() {
    const prefs = IV.state.prefs;
    const status = h('p', { class: 'update-status' });
    const notes = h('div', { class: 'notes-box', hidden: true });
    const actions = h('div', { class: 'row-gap' });

    const feedInput = h('input', {
      type: 'text',
      value: prefs.updateFeedUrl || '',
      spellcheck: 'false',
      placeholder: 'https://example.com/ironvault/updates/',
      onChange: () => apply({ updateFeedUrl: feedInput.value.trim() })
    });
    const pageInput = h('input', {
      type: 'text',
      value: prefs.updateReleasePageUrl || '',
      spellcheck: 'false',
      placeholder: 'https://example.com/ironvault/releases',
      onChange: () => apply({ updateReleasePageUrl: pageInput.value.trim() })
    });

    function render(update) {
      IV.state.update = update;
      status.textContent = describe(update);
      status.className = 'update-status' + (update.status === 'error' ? ' error-line' : '');

      if (update.notes) {
        notes.hidden = false;
        notes.textContent = String(update.notes).replace(/<[^>]+>/g, '').trim();
      } else {
        notes.hidden = true;
      }

      IV.dom.clear(actions);
      actions.append(
        h('button', {
          class: 'btn ghost small',
          text: update.status === 'checking' ? 'Checking...' : 'Check now',
          disabled: update.status === 'checking' || update.status === 'downloading',
          onClick: async () => {
            try {
              render(await IV.api.checkUpdates(true));
            } catch (err) {
              toast(err.message, 'error');
            }
          }
        })
      );
      if (update.status === 'available') {
        actions.append(
          h('button', {
            class: 'btn primary small',
            text: 'Download',
            onClick: async () => {
              try {
                await IV.api.downloadUpdate();
              } catch (err) {
                toast(err.message, 'error');
              }
            }
          })
        );
      }
      if (update.status === 'ready') {
        actions.append(
          h('button', {
            class: 'btn primary small',
            text: 'Install and restart',
            onClick: async () => {
              const ok = await IV.api.confirm({
                title: 'Install update',
                message: 'Install version ' + update.version + ' and restart Ironvault?',
                detail: 'Any open database is locked first. Unsaved changes are saved automatically.',
                confirmLabel: 'Install'
              });
              if (!ok) return;
              await IV.api.lock().catch(() => {});
              await IV.api.installUpdate();
            }
          })
        );
      }
      if (prefs.updateReleasePageUrl) {
        actions.append(
          h('button', {
            class: 'btn ghost small',
            text: 'Release notes',
            onClick: () => IV.api.openReleasePage().catch((err) => toast(err.message, 'error'))
          })
        );
      }
    }

    const handle = modal({
      title: 'Updates',
      body: h(
        'div',
        null,
        status,
        notes,
        actions,
        h('div', { class: 'detail-section' }, h('h3', { text: 'Where to check' })),
        toggle('Check automatically when Ironvault starts', prefs.autoCheckUpdates, (v) =>
          apply({ autoCheckUpdates: v })
        ),
        h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Update feed URL' }), feedInput),
        h('p', {
          class: 'hint',
          text: 'The folder holding latest.yml and the installer. A GitHub release works: https://github.com/USER/REPO/releases/latest/download/'
        }),
        h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Release notes page (optional)' }), pageInput),
        h('p', {
          class: 'hint',
          text: 'Leave the feed URL empty and Ironvault never contacts anything.'
        })
      ),
      footer: [h('button', { class: 'btn primary', text: 'Done', onClick: () => handle.close() })],
      onClose: () => {
        liveUpdatePanel = null;
      }
    });

    liveUpdatePanel = render;
    IV.api
      .updateState()
      .then(render)
      .catch((err) => toast(err.message, 'error'));
    return handle;
  }

  /** Lets app.js push live progress into an open Updates dialog. */
  function onUpdateState(update) {
    if (liveUpdatePanel) liveUpdatePanel(update);
  }

  function openShortcuts() {
    const rows = [
      ['Search', 'Ctrl F'],
      ['New entry', 'Ctrl N'],
      ['New group', 'Ctrl G'],
      ['Edit selected entry', 'Ctrl E'],
      ['Copy username', 'Ctrl B'],
      ['Copy password', 'Ctrl Shift C'],
      ['Copy one time code', 'Ctrl T'],
      ['Open URL', 'Ctrl Shift U'],
      ['Password generator', 'Ctrl P'],
      ['Security audit', 'Ctrl Shift A'],
      ['Save database', 'Ctrl S'],
      ['Lock database', 'Ctrl L'],
      ['Suggest a username', 'the dice button beside Username'],
      ['Settings', 'Ctrl ,'],
      ['Close a dialog', 'Esc']
    ];

    modal({
      title: 'Keyboard shortcuts',
      body: h(
        'table',
        { class: 'kbd-table' },
        h(
          'tbody',
          null,
          rows.map(([label, keys]) =>
            h(
              'tr',
              null,
              h('td', { text: label }),
              h('td', null, keys.split(' ').map((k) => h('kbd', { text: k })))
            )
          )
        )
      )
    });
  }

  function openAbout() {
    const app = IV.state.app;
    modal({
      title: 'About Ironvault',
      body: h(
        'div',
        null,
        h('p', { text: 'Ironvault ' + app.version }),
        h('p', {
          class: 'muted',
          text: 'A KeePass client for Windows. Reads and writes KDBX 3.1 and KDBX 4 files with AES or ChaCha20 and Argon2 or AES-KDF.'
        }),
        h('div', { class: 'detail-section' }, h('h3', { text: 'How your data is handled' })),
        h('ul', { class: 'muted' },
          h('li', { text: 'Everything stays in the .kdbx file you chose. Nothing is uploaded anywhere.' }),
          h('li', { text: 'The app has no network access at all.' }),
          h('li', { text: 'Passwords are only decrypted when you ask to see or copy one.' }),
          h('li', { text: 'Quick unlock stores the master password with Windows DPAPI, tied to your Windows account.' })
        ),
        h('p', { class: 'muted', text: 'Electron ' + app.electron })
      )
    });
  }

  IV.settings = { openSettings, openShortcuts, openAbout, openUpdates, onUpdateState };
})(window.IV);
