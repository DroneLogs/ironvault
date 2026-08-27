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

  function selectField(label, options, value, onChange, hint) {
    const select = h(
      'select',
      { onChange: () => onChange(select.value) },
      options.map((o) => h('option', { value: o.value, selected: o.value === value, text: o.label }))
    );
    return h(
      'label',
      { class: 'field' },
      h('span', { class: 'field-label', text: label }),
      select,
      hint ? h('p', { class: 'hint', text: hint }) : null
    );
  }

  function zoomField(prefs) {
    const output = h('output', { text: Math.round((prefs.zoom || 1) * 100) + '%' });
    const input = h('input', {
      type: 'range',
      min: '80',
      max: '200',
      step: '10',
      value: String(Math.round((prefs.zoom || 1) * 100)),
      onInput: () => {
        output.textContent = input.value + '%';
      },
      onChange: () => apply({ zoom: Number(input.value) / 100 })
    });
    return h(
      'div',
      { class: 'field' },
      h('span', { class: 'field-label', text: 'Text and interface size' }),
      h('div', { class: 'range-row' }, input, output)
    );
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

  /**
   * One picker for the whole look: name, icon and palette move together.
   * The in app logo and name change at once; the taskbar icon is held by
   * Windows against the running process, so that part needs a restart.
   */
  /**
   * Light, dark, or follow the device. Three buttons rather than a switch,
   * because a switch cannot say "whatever Windows is set to" as a third state.
   */
  function appearanceField(prefs) {
    const options = [
      ['light', 'Light'],
      ['dark', 'Dark'],
      ['system', 'Device']
    ];
    const buttons = new Map();
    const group = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Appearance' });

    function mark(value) {
      for (const [key, button] of buttons) {
        const on = key === value;
        button.classList.toggle('active', on);
        button.setAttribute('aria-checked', on ? 'true' : 'false');
        button.tabIndex = on ? 0 : -1;
      }
    }

    for (const [value, label] of options) {
      const button = h('button', {
        class: 'seg-btn',
        role: 'radio',
        text: label,
        onClick: async () => {
          mark(value);
          await apply({ appearance: value });
        }
      });
      buttons.set(value, button);
      group.append(button);
    }

    mark(prefs.appearance === 'light' || prefs.appearance === 'system' ? prefs.appearance : 'dark');

    return h(
      'div',
      { class: 'field' },
      h('span', { class: 'field-label', text: 'Appearance' }),
      group,
      h('p', { class: 'hint', text: 'Device follows the light or dark setting in Windows, and changes with it.' })
    );
  }

  function themeField(prefs) {
    const select = h('select', {
      onChange: async () => {
        await apply({ theme: select.value });

        const info = await IV.api.appInfo();
        IV.state.productName = info.productName;
        IV.state.tagline = info.tagline;
        IV.app.applyBrand();

        const ok = await IV.api.confirm({
          title: 'Restart to finish',
          message: 'Restart now so the taskbar and window icon change too?',
          detail:
            'The colours and the logo inside the app have already changed. Windows holds the ' +
            'taskbar icon against the running program, so only that part needs a restart. Any open ' +
            'database is locked first.',
          confirmLabel: 'Restart now'
        });
        if (!ok) {
          toast('Palette changed. The taskbar icon follows next time you start the app.');
          return;
        }
        await IV.api.lock().catch(() => {});
        await IV.api.relaunch();
      }
    });

    IV.api
      .themes()
      .then((themes) => {
        IV.dom.clear(select);
        for (const theme of themes) {
          select.append(
            h('option', {
              value: theme.key,
              selected: theme.key === (prefs.theme || 'blue-cb'),
              text: theme.name
            })
          );
        }
      })
      .catch(() => {});

    return h(
      'label',
      { class: 'field' },
      h('span', { class: 'field-label', text: 'Palette' }),
      select,
      h('p', {
        class: 'hint',
        text:
          'The two CB palettes swap the colours that merge under colour blindness, mainly green against red. ' +
          'Amber changes the accent and the window icon as well. The installed shortcut and the executable ' +
          'keep the icon the build was made with.'
      })
    );
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
      appearanceField(prefs),
      themeField(prefs),
      h('div', { class: 'detail-section' }, h('h3', { text: 'Accessibility' })),
      selectField(
        'Typeface',
        [
          { value: 'system', label: 'System default' },
          { value: 'dyslexic', label: 'OpenDyslexic (for dyslexia)' },
          { value: 'hyperlegible', label: 'Atkinson Hyperlegible (for low vision)' }
        ],
        prefs.uiFont || 'system',
        (v) => apply({ uiFont: v })
      ),
      zoomField(prefs),
      toggle('Reduce motion', Boolean(prefs.reduceMotion), (v) => apply({ reduceMotion: v }), 'Turns off fades and slides.'),
      toggle('Thicker focus outline', Boolean(prefs.strongFocus), (v) => apply({ strongFocus: v }), 'Easier to follow when moving through the app by keyboard.'),
      toggle(
        'Larger buttons and rows',
        Boolean(prefs.bigTargets),
        (v) => apply({ bigTargets: v }),
        'Grows every control to at least 44 pixels, for tremor or limited fine motor control.'
      ),
      toggle(
        'High contrast',
        Boolean(prefs.highContrast),
        (v) => apply({ highContrast: v }),
        'Near black on near white with heavy borders. Windows own high contrast themes are followed automatically.'
      ),
      h('p', {
        class: 'hint',
        text: 'Out of the box only the colourblind safe palette is on. Everything else here starts off.'
      }),
      h(
        'div',
        { class: 'row-gap' },
        h('button', {
          class: 'btn ghost small',
          text: 'Reset accessibility to defaults',
          onClick: async () => {
            await apply({
              theme: 'blue-cb',
              uiFont: 'system',
              zoom: 1,
              reduceMotion: false,
              strongFocus: false,
              bigTargets: false,
              highContrast: false
            });
            handle.close();
            toast('Accessibility settings reset', 'good');
          }
        })
      ),
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
        return 'No update source is set, so Propolis never checks.';
      case 'idle':
        return update.usingDefaultFeed
          ? 'Set to check the Propolis repository. Version ' + update.currentVersion + '.'
          : 'Version ' + update.currentVersion + '.';
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
      placeholder: 'https://example.com/propolis/updates/',
      onChange: () => apply({ updateFeedUrl: feedInput.value.trim() })
    });
    const pageInput = h('input', {
      type: 'text',
      value: prefs.updateReleasePageUrl || '',
      spellcheck: 'false',
      placeholder: 'https://example.com/propolis/releases',
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
                message: 'Install version ' + update.version + ' and restart Propolis?',
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
        toggle('Check automatically when Propolis starts', prefs.autoCheckUpdates, (v) =>
          apply({ autoCheckUpdates: v })
        ),
        h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Update feed URL' }), feedInput),
        h(
          'div',
          { class: 'row-gap' },
          h('button', {
            class: 'btn ghost small',
            text: 'Use the Propolis repository',
            onClick: async () => {
              const state = await IV.api.updateState();
              feedInput.value = state.defaultFeedUrl;
              await apply({ updateFeedUrl: state.defaultFeedUrl });
              toast('Feed reset to the Propolis repository', 'good');
            }
          }),
          h('button', {
            class: 'btn ghost small',
            text: 'Never check',
            onClick: async () => {
              feedInput.value = '';
              await apply({ updateFeedUrl: '' });
              render(await IV.api.updateState());
              toast('Update checks turned off');
            }
          })
        ),
        h('p', {
          class: 'hint',
          text:
            'This points at the Propolis releases by default. A check asks for latest.yml beside ' +
            'the installer, so a release published without that file cannot be seen however public ' +
            'the repository is. The app sends no credentials, so a private repository cannot be seen either.'
        }),
        h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Release notes page (optional)' }), pageInput),
        h('p', {
          class: 'hint',
          text: 'Leave the feed URL empty and Propolis never contacts anything.'
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
      title: 'About Propolis',
      body: h(
        'div',
        null,
        h('p', { text: 'Propolis ' + app.version }),
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
