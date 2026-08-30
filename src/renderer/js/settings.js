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

  /**
   * Windows protects a whole window from capture or none of it, so there is no
   * way to blur one field. Three honest positions instead of a pretend one.
   *
   * Choosing Always asks first, because it is the one that leaves passwords
   * visible to anything recording the screen.
   */
  /**
   * Screen capture is a grant, not a switch: see capture.js for why. This shows
   * what is in force, and asks for the guard before relaxing anything.
   */
  function describeRemaining(ms) {
    const mins = Math.max(0, Math.round(ms / 60000));
    if (mins < 60) return mins + (mins === 1 ? ' minute' : ' minutes');
    const hours = Math.floor(mins / 60);
    const rest = mins % 60;
    return hours + (hours === 1 ? ' hour' : ' hours') + (rest ? ' ' + rest + ' min' : '');
  }

  async function askForGuard(state) {
    const kind = state.guard;
    if (kind === 'yubikey') {
      throw new Error('YubiKey is not set up as the screen capture guard yet.');
    }
    const label =
      kind === 'vault'
        ? 'Master password for this database'
        : 'Screen capture password';
    return new Promise((resolve) => {
      const input = h('input', { type: 'password', autofocus: true });
      const handle = modal({
        title: 'Confirm it is you',
        body: h(
          'div',
          null,
          h('p', {
            class: 'hint',
            text:
              'Relaxing screen capture lets recording software see your passwords, ' +
              'so it asks first. It goes back on its own when the time runs out, ' +
              'and always when the database locks.'
          }),
          h('label', { class: 'field' }, h('span', { class: 'field-label', text: label }), input)
        ),
        footer: [
          h('button', { class: 'btn ghost', text: 'Cancel', onClick: () => { handle.close(); resolve(null); } }),
          h('button', {
            class: 'btn primary',
            text: 'Confirm',
            onClick: () => { const v = input.value; handle.close(); resolve(v); }
          })
        ]
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { const v = input.value; handle.close(); resolve(v); }
      });
    });
  }

  async function screenCaptureSection() {
    let state;
    try {
      state = await IV.api.captureStatus();
    } catch {
      return null;
    }

    const wrap = h('div', { class: 'detail-section' });

    const statusLine = state.active
      ? h(
          'p',
          { class: 'hint warning' },
          h('strong', {
            text:
              (state.mode === 'always'
                ? 'Screen capture is fully allowed. '
                : 'Screen capture is allowed except while a secret is on screen. ')
          }),
          h('span', { text: describeRemaining(state.remainingMs) + ' left, and it ends as soon as the database locks.' })
        )
      : h('p', {
          class: 'hint',
          text:
            'Protected. Screenshots, screen sharing and recording software cannot see this window. ' +
            'Relaxing this needs the ' +
            (state.guard === 'vault' ? 'master password' : state.guard === 'password' ? 'screen capture password' : 'YubiKey') +
            ', and never lasts past the database locking.'
        });

    async function relax(mode) {
      try {
        const credential = await askForGuard(state);
        if (credential === null) return;
        await IV.api.captureRequest(mode, credential, state.grantMinutes);
        toast('Screen capture allowed for ' + describeRemaining(state.grantMinutes * 60000), 'good');
        reopenSettings();
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    const buttons = h(
      'div',
      { class: 'row-actions' },
      state.active
        ? h('button', {
            class: 'btn primary',
            text: 'Protect again now',
            onClick: async () => {
              await IV.api.captureRevoke();
              toast('Screen capture protection is back on', 'good');
              reopenSettings();
            }
          })
        : null,
      !state.active
        ? h('button', {
            class: 'btn ghost',
            text: 'Allow, except while a secret shows',
            onClick: () => relax('unlessRevealed')
          })
        : null,
      !state.active
        ? h('button', { class: 'btn ghost', text: 'Allow fully', onClick: () => relax('always') })
        : null
    );

    wrap.append(
      h('h3', { text: 'Screen capture' }),
      statusLine,
      buttons,
      selectField(
        'Ask for',
        [
          { value: 'vault', label: 'The master password of the open database' },
          { value: 'password', label: 'A separate screen capture password' },
          { value: 'yubikey', label: 'A YubiKey (not set up yet)' }
        ],
        state.guard,
        async (v) => {
          try {
            await IV.api.captureSetGuard(v);
            if (v === 'password' && !state.hasSeparatePassword) {
              toast('Set a screen capture password below', 'good');
            }
            reopenSettings();
          } catch (err) {
            toast(err.message, 'error');
          }
        },
        'Who is allowed to turn protection off. A separate password suits somebody ' +
          'demonstrating the app who should not hold the master key.'
      ),
      numberField(
        'Allow for at most',
        state.grantMinutes,
        1,
        480,
        'minutes',
        async (v) => {
          await IV.api.captureSetMinutes(v);
        }
      ),
      state.guard === 'password'
        ? h(
            'div',
            { class: 'row-actions' },
            h('button', {
              class: 'btn ghost',
              text: state.hasSeparatePassword ? 'Change the screen capture password' : 'Set a screen capture password',
              onClick: () => {
                const input = h('input', { type: 'password', autofocus: true });
                const handle = modal({
                  title: 'Screen capture password',
                  body: h(
                    'div',
                    null,
                    h('p', { class: 'hint', text: 'At least 8 characters. This only unlocks the screen capture setting, nothing else.' }),
                    h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'New password' }), input)
                  ),
                  footer: [
                    h('button', { class: 'btn ghost', text: 'Cancel', onClick: () => handle.close() }),
                    h('button', {
                      class: 'btn primary',
                      text: 'Save',
                      onClick: async () => {
                        try {
                          await IV.api.captureSetPassword(input.value);
                          handle.close();
                          toast('Screen capture password set', 'good');
                          reopenSettings();
                        } catch (err) {
                          toast(err.message, 'error');
                        }
                      }
                    })
                  ]
                });
              }
            }),
            state.hasSeparatePassword
              ? h('button', {
                  class: 'btn ghost',
                  text: 'Remove it',
                  onClick: async () => {
                    await IV.api.captureClearPassword();
                    toast('Screen capture password removed', 'good');
                    reopenSettings();
                  }
                })
              : null
          )
        : null
    );
    return wrap;
  }

  /**
   * Windows keeps a clipboard history (Win+V) and can sync it between machines.
   * Both are off unless the user turned them on, and both record copied
   * passwords when on. Electron cannot mark a clipboard item to opt out, so the
   * honest thing is to notice and say so rather than fail silently.
   */
  async function clipboardWarning() {
    let risk = null;
    try {
      risk = await IV.api.clipboardRisk();
    } catch {
      return null;
    }
    if (!risk || (!risk.history && !risk.cloud)) return null;
    const which = risk.history && risk.cloud
      ? 'Clipboard history and cloud clipboard are'
      : risk.history
        ? 'Clipboard history is'
        : 'Cloud clipboard is';
    return h(
      'p',
      { class: 'hint warning' },
      h('strong', { text: which + ' switched on in Windows. ' }),
      h('span', {
        text:
          'Passwords you copy are being recorded there, and clearing the clipboard ' +
          'here does not remove them. Turn it off in Windows Settings under ' +
          'System > Clipboard, or use auto-type instead of copying.'
      })
    );
  }

  /**
   * Email aliases. The key is a credential, so it is sealed with DPAPI in the
   * main process and never comes back out: this screen only ever learns whether
   * one is stored, not what it is.
   */
  async function aliasSection() {
    let state;
    try {
      state = await IV.api.aliasStatus();
    } catch {
      return null;
    }

    const wrap = h('div', { class: 'detail-section' });
    const chosen = state.provider || 'simplelogin';
    const rows = h('div', null);

    function renderRows() {
      IV.dom.clear(rows);
      const provider = (state.providers || []).find((p) => p.key === chosenRef.value);
      if (!provider) return;

      const keyInput = h('input', {
        type: 'password',
        placeholder: provider.hasKey ? 'A key is saved. Paste a new one to replace it.' : 'Paste your API key'
      });

      rows.append(
        // A button rather than a link: this hands the URL to the system browser
        // instead of navigating, and the app has no anchor styling at all, so a
        // real link falls back to the browser blue and is unreadable on dark.
        h('p', { class: 'hint', text: 'You need an API key from ' + provider.name + '.' }),
        provider.note ? h('p', { class: 'hint warning', text: provider.note }) : null,
        h(
          'div',
          { class: 'row-gap' },
          h('button', {
            class: 'btn ghost small',
            text: 'Open the ' + provider.name + ' key page',
            onClick: () => IV.api.openUrl(provider.keyUrl).catch(() => {})
          })
        ),
        h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'API key' }), keyInput),
        h(
          'div',
          { class: 'row-gap' },
          h('button', {
            class: 'btn primary small',
            text: 'Save and test',
            onClick: async () => {
              try {
                if (keyInput.value.trim()) {
                  await IV.api.aliasSaveKey(provider.key, keyInput.value.trim());
                }
                const result = await IV.api.aliasVerify(provider.key);
                toast(
                  result.account
                    ? 'Connected to ' + provider.name + ' as ' + result.account
                    : 'Connected to ' + provider.name,
                  'good'
                );
                reopenSettings();
              } catch (err) {
                toast(err.message, 'error');
              }
            }
          }),
          provider.hasKey
            ? h('button', {
                class: 'btn ghost small',
                text: 'Remove the key',
                onClick: async () => {
                  await IV.api.aliasClearKey(provider.key);
                  toast(provider.name + ' key removed', 'good');
                  reopenSettings();
                }
              })
            : null
        )
      );
    }

    const chosenRef = { value: chosen };
    const picker = selectField(
      'Set up which provider',
      (state.providers || []).map((p) => ({
        value: p.key,
        label: p.name + (p.hasKey ? ' (key saved)' : '')
      })),
      chosen,
      (v) => {
        chosenRef.value = v;
        renderRows();
      },
      'An alias is a real forwarding address. Mail sent to it reaches you, and you ' +
        'can switch it off later when it starts getting spam. Set up as many as you ' +
        'like: every one with a key saved is offered when you make an alias, so you ' +
        'can pick between them at the time.'
    );

    wrap.append(h('h3', { text: 'Email aliases' }), picker, rows);
    renderRows();

    wrap.append(
      h('div', { class: 'detail-section' }),
      toggle(
        'Also suggest a made up email address',
        state.allowInventedEmail === true,
        async (v) => {
          if (v) {
            const ok = await IV.api.confirm({
              title: 'Suggest a made up address',
              message: 'This is not an alias. Nothing creates the mailbox.',
              detail:
                'It builds an address from a name, a number and a real provider\'s ' +
                'domain. No mailbox is created, the domain belongs to somebody else, ' +
                'and the address may already be a real person\'s. Mail sent to it will ' +
                'not reach you. Only useful for a form that will never send you anything.',
              confirmLabel: 'Suggest it anyway',
              destructive: true
            });
            if (!ok) {
              reopenSettings();
              return;
            }
          }
          await apply({ allowInventedEmail: v });
          reopenSettings();
        }
      )
    );

    return wrap;
  }

  /**
   * Setting up the browser extension.
   *
   * Three steps, and they have to happen in this order, so the screen shows
   * them in it: switch the connection on, load the extension and tell Propolis
   * its id, then approve the browser when it asks. The id cannot be guessed
   * because the browser invents it for a side loaded extension, which is why
   * this asks for it rather than doing it silently.
   */
  async function browserSection() {
    let state;
    try {
      state = await IV.api.browserStatus();
    } catch {
      return null;
    }

    const wrap = h('div', { class: 'detail-section' });
    wrap.append(
      h('h3', { text: 'Browser extension' }),
      h('p', {
        class: 'hint',
        text:
          'Fills passwords into web pages. The extension talks to Propolis over a ' +
          'private channel on this machine, encrypted end to end, and nothing is ' +
          'sent anywhere. Passwords are only ever given out for a site the entry ' +
          'belongs to, and only while this database is unlocked.'
      }),
      toggle('Allow browsers to connect', state.enabled === true, async (v) => {
        await IV.api.browserEnable(v);
        reopenSettings();
      })
    );

    if (!state.enabled) return wrap;

    const idInput = h('input', {
      type: 'text',
      spellcheck: 'false',
      placeholder: 'The id from your browser extensions page'
    });
    const browserSelect = h(
      'select',
      null,
      (state.install.browsers || []).map((b) =>
        h('option', { value: b.key, text: b.name + (b.registered ? ' (set up)' : '') })
      )
    );

    wrap.append(
      h('p', {
        class: 'hint',
        text:
          'Step 1. Load the extension. It is in the extension folder where Propolis ' +
          'is installed. In your browser open the extensions page, switch on ' +
          'developer mode, and choose Load unpacked.'
      }),
      h(
        'div',
        { class: 'row-gap' },
        h('button', {
          class: 'btn ghost small',
          text: 'Open the extension folder',
          onClick: () => IV.api.browserReveal().catch((err) => toast(err.message, 'error'))
        })
      ),
      h('p', {
        class: 'hint',
        text:
          'Step 2. Copy the id your browser shows on the extension card, pick the ' +
          'browser below, and press Set up. Then restart the browser.'
      }),
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Browser' }), browserSelect),
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Extension id' }), idInput),
      h(
        'div',
        { class: 'row-gap' },
        h('button', {
          class: 'btn primary small',
          text: 'Set up',
          onClick: async () => {
            try {
              await IV.api.browserRegister(browserSelect.value, idInput.value.trim());
              toast('Set up. Restart the browser, then press the Propolis button in it.', 'good');
              reopenSettings();
            } catch (err) {
              toast(err.message, 'error');
            }
          }
        }),
        h('button', {
          class: 'btn ghost small',
          text: 'Remove setup',
          onClick: async () => {
            await IV.api.browserUnregister(browserSelect.value);
            toast('Removed');
            reopenSettings();
          }
        })
      ),
      h('p', {
        class: 'hint',
        text: 'Step 3. Press the Propolis button in the browser and approve it here when asked.'
      })
    );

    const connections = state.connections || [];
    wrap.append(
      h('div', { class: 'detail-section' }, h('h3', { text: 'Connected browsers' })),
      connections.length
        ? h(
            'div',
            null,
            ...connections.map((c) =>
              h(
                'div',
                { class: 'row-gap' },
                h('span', { text: c.name }),
                h('button', {
                  class: 'btn ghost small',
                  text: 'Disconnect',
                  onClick: async () => {
                    await IV.api.browserForget(c.id);
                    toast(c.name + ' disconnected');
                    reopenSettings();
                  }
                })
              )
            )
          )
        : h('p', { class: 'hint', text: 'None yet. A browser appears here once you approve it.' })
    );

    return wrap;
  }

  /**
   * Syncing between two machines on the same network.
   *
   * Pairing is laid out the way it actually happens: one machine shows a code,
   * the other finds it and types the code in. Both halves are on this screen,
   * because it is the same person walking between two computers.
   */
  async function lanSection() {
    let state;
    try {
      state = await IV.api.lanStatus();
    } catch {
      return null;
    }

    const wrap = h('div', { class: 'detail-section' });
    wrap.append(
      h('h3', { text: 'Sync over your network' }),
      h('p', {
        class: 'hint',
        text:
          'Sync straight to another computer running Propolis on the same network, ' +
          'with no server in between and nothing leaving the building. Both ' +
          'databases have to be open, and both are merged, so neither computer ' +
          'is left behind.'
      }),
      toggle('Allow computers on this network to pair', state.running === true, async (v) => {
        await IV.api.lanEnable(v);
        reopenSettings();
      })
    );

    if (!state.running) return wrap;

    const nameInput = h('input', {
      type: 'text',
      value: state.name,
      spellcheck: 'false',
      onChange: async () => {
        await IV.api.lanSetName(nameInput.value.trim());
        toast('Name changed', 'good');
      }
    });

    wrap.append(
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'This computer is called' }), nameInput),
      h('p', {
        class: 'hint',
        text:
          'Its fingerprint is ' + state.fingerprint +
          (state.addresses.length ? ', at ' + state.addresses.join(' or ') : '') + '.'
      })
    );

    const codeBox = h('div');
    wrap.append(
      h('div', { class: 'detail-section' }, h('h3', { text: 'Pair another computer' })),
      h('p', {
        class: 'hint',
        text: 'On one computer show a code, then on the other find it and type the code in.'
      }),
      h(
        'div',
        { class: 'row-gap' },
        h('button', {
          class: 'btn ghost small',
          text: 'Show a pairing code',
          onClick: async () => {
            try {
              const started = await IV.api.lanBeginPairing();
              IV.dom.clear(codeBox);
              codeBox.append(
                h('p', { class: 'hint', text: 'Type this on the other computer. It works once, and expires.' }),
                h('div', { class: 'pair-code', text: started.code })
              );
            } catch (err) {
              toast(err.message, 'error');
            }
          }
        }),
        h('button', {
          class: 'btn ghost small',
          text: 'Stop showing it',
          onClick: async () => {
            await IV.api.lanCancelPairing();
            IV.dom.clear(codeBox);
            toast('No longer pairing');
          }
        })
      ),
      codeBox
    );

    const foundBox = h('div');
    wrap.append(
      h(
        'div',
        { class: 'row-gap' },
        h('button', {
          class: 'btn ghost small',
          text: 'Find a computer showing a code',
          onClick: async () => {
            IV.dom.clear(foundBox);
            foundBox.append(h('p', { class: 'hint', text: 'Looking...' }));
            let found = [];
            try {
              found = await IV.api.lanDiscover();
            } catch (err) {
              toast(err.message, 'error');
            }
            IV.dom.clear(foundBox);
            if (!found.length) {
              foundBox.append(
                h('p', {
                  class: 'hint',
                  text:
                    'Nothing answered. The other computer needs Propolis open, this ' +
                    'setting switched on, and a pairing code showing.'
                })
              );
              return;
            }
            for (const device of found) {
              const codeInput = h('input', {
                type: 'text',
                placeholder: 'The code it is showing',
                spellcheck: 'false'
              });
              foundBox.append(
                h(
                  'div',
                  { class: 'field' },
                  h('span', { class: 'field-label', text: device.name + '  (' + device.address + ')' }),
                  codeInput,
                  h('p', { class: 'hint', text: 'Its fingerprint is ' + device.fingerprint + '.' }),
                  h(
                    'div',
                    { class: 'row-gap' },
                    h('button', {
                      class: 'btn primary small',
                      text: 'Pair',
                      onClick: async () => {
                        try {
                          await IV.api.lanPair({
                            address: device.address,
                            port: device.port,
                            code: codeInput.value,
                            name: device.name
                          });
                          toast('Paired with ' + device.name, 'good');
                          reopenSettings();
                        } catch (err) {
                          toast(err.message, 'error');
                        }
                      }
                    })
                  )
                )
              );
            }
          }
        })
      ),
      foundBox
    );

    const paired = state.peers || [];
    wrap.append(h('div', { class: 'detail-section' }, h('h3', { text: 'Paired computers' })));
    if (!paired.length) {
      wrap.append(h('p', { class: 'hint', text: 'None yet.' }));
      return wrap;
    }
    for (const peer of paired) {
      wrap.append(
        h(
          'div',
          { class: 'row-gap' },
          h('span', { text: peer.name + '  ' + peer.fingerprint }),
          h('button', {
            class: 'btn primary small',
            text: 'Sync now',
            onClick: async (e) => {
              const button = e.currentTarget;
              button.disabled = true;
              button.textContent = 'Syncing...';
              try {
                const result = await IV.api.lanSync(peer.id);
                toast(
                  result.merged || result.theirMerged
                    ? 'Synced. ' + result.merged + ' came here, ' + result.theirMerged + ' went there.'
                    : 'Synced. Both were already up to date.',
                  'good'
                );
              } catch (err) {
                toast(err.message, 'error');
              }
              button.disabled = false;
              button.textContent = 'Sync now';
            }
          }),
          h('button', {
            class: 'btn ghost small',
            text: 'Unpair',
            onClick: async () => {
              await IV.api.lanForget(peer.id);
              toast(peer.name + ' unpaired');
              reopenSettings();
            }
          })
        )
      );
    }
    return wrap;
  }

  async function apply(patch) {
    IV.state.prefs = await IV.api.setPrefs(patch);
    IV.app.applyTheme();
  }

  /**
   * Redraws Settings in place after something changed.
   *
   * Every section that changes a setting has to show the result, and the way it
   * did that was to call openSettings again, which opened a second dialog on top
   * of the first. Setting up two providers left three stacked, and closing one
   * revealed another underneath.
   *
   * Closing the open one first makes it a redraw instead of a pile.
   */
  function reopenSettings() {
    const top = IV.dom.topModal && IV.dom.topModal();
    if (top && typeof top.close === 'function') top.close();
    return openSettings();
  }

  async function openSettings() {
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
      await lanSection(),
      await browserSection(),
      await aliasSection(),
      await screenCaptureSection(),
      h('div', { class: 'detail-section' }, h('h3', { text: 'YubiKey' })),
      h('p', {
        class: 'hint warning',
        text:
          'Unlocking with a YubiKey is written but has never been run against a real ' +
          'key, so compatibility is not guaranteed. It stays off until you turn it on. ' +
          'If you do, test your key before binding a database to it, and keep a backup: ' +
          'a database bound to a key that does not work cannot be opened.'
      }),
      toggle('Allow unlocking with a YubiKey (beta)', prefs.yubikeyBeta === true, async (v) => {
        if (v) {
          const ok = await IV.api.confirm({
            title: 'Turn on YubiKey support',
            message: 'This part of the app has never been tested against real hardware.',
            detail:
              'Everything that could be checked without a key was checked, but every ' +
              'code path that talks to a device is unproven. Test your key before you ' +
              'bind a database to it, and back the database up first.',
            confirmLabel: 'Turn it on',
            destructive: true
          });
          if (!ok) {
            reopenSettings();
            return;
          }
        }
        await apply({ yubikeyBeta: v });
        reopenSettings();
      }),
      await clipboardWarning(),
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
          }),
          // Without this the prompt would reappear on every launch until the
          // user gave in, which is how update prompts get resented.
          h('button', {
            class: 'btn ghost small',
            text: 'Skip this version',
            onClick: async () => {
              await apply({ skippedUpdateVersion: update.version });
              toast('Propolis will not bring up ' + update.version + ' again');
              handle.close();
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

  /**
   * Opens the Updates dialog because a check found something on its own.
   *
   * Three things stop it being a nuisance: a version the user skipped is never
   * raised again, it asks once per run rather than on every check, and it does
   * not interrupt while a dialog is already open, since being pulled out of
   * editing an entry to be told about an update is worse than being told late.
   */
  let updatePromptedFor = null;

  function promptForUpdate(update) {
    if (!update || update.status !== 'available' || !update.version) return;
    if (update.version === (IV.state.prefs.skippedUpdateVersion || null)) return;
    if (updatePromptedFor === update.version) return;
    if (IV.dom.topModal && IV.dom.topModal()) return;
    updatePromptedFor = update.version;
    openUpdates();
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

  IV.settings = { openSettings, openShortcuts, openAbout, openUpdates, onUpdateState, promptForUpdate };
})(window.IV);
