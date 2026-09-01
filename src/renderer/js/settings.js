/* Settings, database properties, shortcuts, and about. */
window.IV = window.IV || {};

(function (IV) {
  'use strict';

  const { h, modal, toast } = IV.dom;

  // The three field helpers translate their own label, hint and suffix, so
  // every settings row is covered without wrapping each call. Safe for the few
  // that are handed a computed name: an unknown string comes back unchanged.
  function numberField(label, value, min, max, suffix, onChange) {
    label = tr(label);
    suffix = suffix ? tr(suffix) : suffix;
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

  function toggle(label, checked, onChange, hint) {
    label = tr(label);
    hint = hint ? tr(hint) : hint;
    const input = h('input', { type: 'checkbox', checked, onChange: () => onChange(input.checked) });
    const line = h('label', { class: 'checkline' }, input, h('span', { text: label }));
    // A switch whose consequence is not obvious needs a sentence under it,
    // the same way the dropdowns get one.
    if (!hint) return line;
    return h('div', { class: 'checkline-group' }, line, h('p', { class: 'hint', text: hint }));
  }

  function selectField(label, options, value, onChange, hint) {
    label = tr(label);
    hint = hint ? tr(hint) : hint;
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
      h('span', { class: 'field-label', text: tr('Text and interface size') }),
      h('div', { class: 'range-row' }, input, output)
    );
  }

  /** A text box rather than a key capture: Electron accelerators are text. */
  function hotkeyField(prefs) {
    const input = h('input', {
      type: 'text',
      value: prefs.autoTypeHotkey || '',
      placeholder: tr('Control+Alt+A'),
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
      h('span', { class: 'field-label', text: tr('Auto-type hotkey') }),
      input,
      h('p', { class: 'hint', text: tr('Press this anywhere in Windows to type into the front window. Empty turns it off.') })
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
      h('span', { class: 'field-label', text: tr('Appearance') }),
      group,
      h('p', { class: 'hint', text: tr('Device follows the light or dark setting in Windows, and changes with it.') })
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
          title: tr('Restart to finish'),
          message: 'Restart now so the taskbar and window icon change too?',
          detail:
            'The colours and the logo inside the app have already changed. Windows holds the ' +
            'taskbar icon against the running program, so only that part needs a restart. Any open ' +
            'database is locked first.',
          confirmLabel: tr('Restart now')
        });
        if (!ok) {
          toast(tr('Palette changed. The taskbar icon follows next time you start the app.'));
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
      h('span', { class: 'field-label', text: tr('Palette') }),
      select,
      h('p', {
        class: 'hint',
        text:
          tr('The two CB palettes swap the colours that merge under colour blindness, mainly green against red. ') +
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
        title: tr('Confirm it is you'),
        body: h(
          'div',
          null,
          h('p', {
            class: 'hint',
            text:
              tr('Relaxing screen capture lets recording software see your passwords, ') +
              'so it asks first. It goes back on its own when the time runs out, ' +
              'and always when the database locks.'
          }),
          h('label', { class: 'field' }, h('span', { class: 'field-label', text: label }), input)
        ),
        footer: [
          h('button', { class: 'btn ghost', text: tr('Cancel'), onClick: () => { handle.close(); resolve(null); } }),
          h('button', {
            class: 'btn primary',
            text: tr('Confirm'),
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
            tr('Protected. Screenshots, screen sharing and recording software cannot see this window. ') +
            'Relaxing this needs the ' +
            (state.guard === 'vault' ? 'master password' : state.guard === 'password' ? 'screen capture password' : 'YubiKey') +
            ', and never lasts past the database locking.'
        });

    async function relax(mode) {
      try {
        const credential = await askForGuard(state);
        if (credential === null) return;
        await IV.api.captureRequest(mode, credential, state.grantMinutes);
        toast(tr('Screen capture allowed for ') + describeRemaining(state.grantMinutes * 60000), 'good');
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
            text: tr('Protect again now'),
            onClick: async () => {
              await IV.api.captureRevoke();
              toast(tr('Screen capture protection is back on'), 'good');
              reopenSettings();
            }
          })
        : null,
      !state.active
        ? h('button', {
            class: 'btn ghost',
            text: tr('Allow, except while a secret shows'),
            onClick: () => relax('unlessRevealed')
          })
        : null,
      !state.active
        ? h('button', { class: 'btn ghost', text: tr('Allow fully'), onClick: () => relax('always') })
        : null
    );

    wrap.append(
      h('h3', { text: tr('Screen capture') }),
      statusLine,
      buttons,
      selectField(
        'Ask for',
        [
          { value: 'vault', label: tr('The master password of the open database') },
          { value: 'password', label: tr('A separate screen capture password') },
          { value: 'yubikey', label: tr('A YubiKey (not set up yet)') }
        ],
        state.guard,
        async (v) => {
          try {
            await IV.api.captureSetGuard(v);
            if (v === 'password' && !state.hasSeparatePassword) {
              toast(tr('Set a screen capture password below'), 'good');
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
                  title: tr('Screen capture password'),
                  body: h(
                    'div',
                    null,
                    h('p', { class: 'hint', text: tr('At least 8 characters. This only unlocks the screen capture setting, nothing else.') }),
                    h('label', { class: 'field' }, h('span', { class: 'field-label', text: tr('New password') }), input)
                  ),
                  footer: [
                    h('button', { class: 'btn ghost', text: tr('Cancel'), onClick: () => handle.close() }),
                    h('button', {
                      class: 'btn primary',
                      text: tr('Save'),
                      onClick: async () => {
                        try {
                          await IV.api.captureSetPassword(input.value);
                          handle.close();
                          toast(tr('Screen capture password set'), 'good');
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
                  text: tr('Remove it'),
                  onClick: async () => {
                    await IV.api.captureClearPassword();
                    toast(tr('Screen capture password removed'), 'good');
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
          tr('Passwords you copy are being recorded there, and clearing the clipboard ') +
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

      IV.dom.add(rows,
        // A button rather than a link: this hands the URL to the system browser
        // instead of navigating, and the app has no anchor styling at all, so a
        // real link falls back to the browser blue and is unreadable on dark.
        h('p', { class: 'hint', text: tr('You need an API key from ') + provider.name + '.' }),
        provider.note ? h('p', { class: 'hint warning', text: provider.note }) : null,
        h(
          'div',
          { class: 'row-gap' },
          h('button', {
            class: 'btn ghost small',
            text: tr('Open the ') + provider.name + ' key page',
            onClick: () => IV.api.openUrl(provider.keyUrl).catch(() => {})
          })
        ),
        h('label', { class: 'field' }, h('span', { class: 'field-label', text: tr('API key') }), keyInput),
        h(
          'div',
          { class: 'row-gap' },
          h('button', {
            class: 'btn primary small',
            text: tr('Save and test'),
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
                text: tr('Remove the key'),
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

    wrap.append(h('h3', { text: tr('Email aliases') }), picker, rows);
    renderRows();

    wrap.append(
      h('div', { class: 'detail-section' }),
      toggle(
        'Also suggest a made up email address',
        state.allowInventedEmail === true,
        async (v) => {
          if (v) {
            const ok = await IV.api.confirm({
              title: tr('Suggest a made up address'),
              message: 'This is not an alias. Nothing creates the mailbox.',
              detail:
                'It builds an address from a name, a number and a real provider\'s ' +
                'domain. No mailbox is created, the domain belongs to somebody else, ' +
                'and the address may already be a real person\'s. Mail sent to it will ' +
                'not reach you. Only useful for a form that will never send you anything.',
              confirmLabel: tr('Suggest it anyway'),
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
      h('h3', { text: tr('Browser extension') }),
      h('p', {
        class: 'hint',
        text:
          tr('Fills passwords into web pages. The extension talks to Propolis over a ') +
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
      placeholder: tr('The id from your browser extensions page')
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
          tr('Step 1. Load the extension. Press the button below to open the folder it ') +
          'lives in, then in your browser open the extensions page, switch on ' +
          'developer mode, and choose Load unpacked. Always load it from that ' +
          'folder: your browser works out the extension id from where it was ' +
          'loaded, and loading a copy from anywhere else gives a different id that ' +
          'will not be allowed to connect.'
      }),
      h(
        'div',
        { class: 'row-gap' },
        h('button', {
          class: 'btn ghost small',
          text: tr('Open the extension folder'),
          onClick: () => IV.api.browserReveal().catch((err) => toast(err.message, 'error'))
        })
      ),
      h('p', {
        class: 'hint',
        text:
          tr('Step 2. Copy the id your browser shows on the extension card, pick the ') +
          'browser below, and press Set up. Then restart the browser.'
      }),
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: tr('Browser') }), browserSelect),
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: tr('Extension id') }), idInput),
      h(
        'div',
        { class: 'row-gap' },
        h('button', {
          class: 'btn primary small',
          text: tr('Set up'),
          onClick: async () => {
            try {
              await IV.api.browserRegister(browserSelect.value, idInput.value.trim());
              toast(tr('Set up. Restart the browser, then press the Propolis button in it.'), 'good');
              reopenSettings();
            } catch (err) {
              toast(err.message, 'error');
            }
          }
        }),
        h('button', {
          class: 'btn ghost small',
          text: tr('Remove setup'),
          onClick: async () => {
            await IV.api.browserUnregister(browserSelect.value);
            toast(tr('Removed'));
            reopenSettings();
          }
        })
      ),
      h('p', {
        class: 'hint',
        text: tr('Step 3. Press the Propolis button in the browser and approve it here when asked.')
      })
    );

    const connections = state.connections || [];
    wrap.append(
      h('div', { class: 'detail-section' }, h('h3', { text: tr('Connected browsers') })),
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
                  text: tr('Disconnect'),
                  onClick: async () => {
                    await IV.api.browserForget(c.id);
                    toast(c.name + ' disconnected');
                    reopenSettings();
                  }
                })
              )
            )
          )
        : h('p', { class: 'hint', text: tr('None yet. A browser appears here once you approve it.') })
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
      h('h3', { text: tr('Sync over your network') }),
      h('p', {
        class: 'hint',
        text:
          tr('Sync straight to another computer running Propolis on the same network, ') +
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
        toast(tr('Name changed'), 'good');
      }
    });

    wrap.append(
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: tr('This computer is called') }), nameInput),
      h('p', {
        class: 'hint',
        text:
          tr('Its fingerprint is ') + state.fingerprint +
          (state.addresses.length ? ', at ' + state.addresses.join(' or ') : '') + '.'
      })
    );

    const codeBox = h('div');
    wrap.append(
      h('div', { class: 'detail-section' }, h('h3', { text: tr('Pair another computer') })),
      h('p', {
        class: 'hint',
        text: tr('On one computer show a code, then on the other find it and type the code in.')
      }),
      h(
        'div',
        { class: 'row-gap' },
        h('button', {
          class: 'btn ghost small',
          text: tr('Show a pairing code'),
          onClick: async () => {
            try {
              const started = await IV.api.lanBeginPairing();
              IV.dom.clear(codeBox);
              codeBox.append(
                h('p', { class: 'hint', text: tr('Type this on the other computer. It works once, and expires.') }),
                h('div', { class: 'pair-code', text: started.code })
              );
            } catch (err) {
              toast(err.message, 'error');
            }
          }
        }),
        h('button', {
          class: 'btn ghost small',
          text: tr('Stop showing it'),
          onClick: async () => {
            await IV.api.lanCancelPairing();
            IV.dom.clear(codeBox);
            toast(tr('No longer pairing'));
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
          text: tr('Find a computer showing a code'),
          onClick: async () => {
            IV.dom.clear(foundBox);
            foundBox.append(h('p', { class: 'hint', text: tr('Looking...') }));
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
                    tr('Nothing answered. The other computer needs Propolis open, this ') +
                    'setting switched on, and a pairing code showing.'
                })
              );
              return;
            }
            for (const device of found) {
              const codeInput = h('input', {
                type: 'text',
                placeholder: tr('The code it is showing'),
                spellcheck: 'false'
              });
              foundBox.append(
                h(
                  'div',
                  { class: 'field' },
                  h('span', { class: 'field-label', text: device.name + '  (' + device.address + ')' }),
                  codeInput,
                  h('p', { class: 'hint', text: tr('Its fingerprint is ') + device.fingerprint + '.' }),
                  h(
                    'div',
                    { class: 'row-gap' },
                    h('button', {
                      class: 'btn primary small',
                      text: tr('Pair'),
                      onClick: async () => {
                        try {
                          await IV.api.lanPair({
                            address: device.address,
                            port: device.port,
                            code: codeInput.value,
                            name: device.name
                          });
                          toast(tr('Paired with ') + device.name, 'good');
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
    wrap.append(h('div', { class: 'detail-section' }, h('h3', { text: tr('Paired computers') })));
    if (!paired.length) {
      wrap.append(h('p', { class: 'hint', text: tr('None yet.') }));
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
            text: tr('Sync now'),
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
            text: tr('Unpair'),
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
    return openSettings(settingsPage);
  }

  /**
   * Settings, as pages rather than one very long scroll.
   *
   * It grew to include network sync, the browser extension, alias providers,
   * screen capture and YubiKey, all under the clipboard timeout, and finding
   * anything meant scrolling past everything. The groups below are by what
   * somebody came to do, not by which part of the code owns the setting.
   *
   * The page in view is remembered, so changing something and being redrawn
   * leaves you where you were instead of back at the top.
   */
  let settingsPage = 'general';

  function pageDatabase(info) {
    if (!info || !info.open) {
      return h('p', { class: 'hint', text: tr('Open a database to see anything about it here.') });
    }

    const quickToggle = h('input', {
      type: 'checkbox',
      checked: IV.state.hasQuickUnlock,
      onChange: async () => {
        if (quickToggle.checked) {
          quickToggle.checked = false;
          toast(tr('Tick "remember this password" on the unlock screen to turn this on'));
          return;
        }
        await IV.api.setQuickUnlock({ filePath: info.filePath, enabled: false });
        IV.state.hasQuickUnlock = false;
        toast(tr('Stored password removed'), 'good');
      }
    });

    return h(
      'div',
      null,
      h(
        'div',
        { class: 'meta-grid' },
        h('div', null, h('b', { text: tr('Name') }), info.name),
        h('div', null, h('b', { text: tr('Format') }), 'KDBX ' + info.version),
        h('div', null, h('b', { text: tr('Key derivation') }), info.kdf),
        h('div', null, h('b', { text: tr('Cipher') }), info.cipher),
        h('div', null, h('b', { text: tr('Entries') }), String(info.entryCount)),
        h('div', null, h('b', { text: tr('Groups') }), String(info.groupCount))
      ),
      h('p', { class: 'path-line', text: info.filePath }),
      h('label', { class: 'checkline' }, quickToggle, h('span', { text: tr('Quick unlock stored on this Windows account') })),
      h(
        'div',
        { class: 'row-gap' },
        h('button', { class: 'btn ghost small', text: tr('Change master key'), onClick: () => IV.editor.openMasterKeyDialog() }),
        h('button', {
          class: 'btn ghost small',
          text: tr('Save a copy...'),
          onClick: async () => {
            try {
              const result = await IV.api.saveAs();
              if (result) toast(tr('Saved to ') + result.filePath, 'good');
              await IV.app.refresh();
            } catch (err) {
              toast(err.message, 'error');
            }
          }
        }),
        h('button', {
          class: 'btn ghost small',
          text: tr('Show in Explorer'),
          onClick: () => IV.api.revealInFolder(info.filePath)
        })
      ),
      h(
        'div',
        { class: 'row-gap' },
        h('button', {
          class: 'btn danger small',
          text: tr('Empty recycle bin'),
          onClick: async () => {
            const ok = await IV.api.confirm({
              title: tr('Empty recycle bin'),
              message: 'Permanently delete everything in the recycle bin?',
              detail: 'This cannot be undone.',
              confirmLabel: tr('Empty'),
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
    );
  }

  function pageGeneral(prefs) {
    return h(
      'div',
      null,
      selectField(
        'Language',
        IV.i18n.available().map((l) => ({ value: l.code, label: l.name })),
        prefs.language || 'en',
        async (value) => {
          await apply({ language: value });
          // Each screen reads its words as it is built, so whatever is already
          // drawn would stay in the old language. Rebuilding everything would
          // mean returning to the lock screen with the database still open
          // behind it, so this waits for a restart instead.
          const ok = await IV.api.confirm({
            title: tr('Restart to finish'),
            message: tr('Restart Propolis now to change the language?'),
            confirmLabel: tr('Restart now'),
            cancelLabel: tr('Not now')
          });
          if (!ok) return;
          await IV.api.lock().catch(() => {});
          await IV.api.relaunch();
        },
        'Changes when Propolis restarts.'
      ),
      numberField('Clear the clipboard after', prefs.clipboardClearSeconds, 0, 600, 'seconds (0 to keep)', (v) =>
        apply({ clipboardClearSeconds: v })
      ),
      toggle('Render notes as Markdown', prefs.markdownNotes !== false, (v) => apply({ markdownNotes: v })),
      toggle(
        'Fetch site icons for new entries',
        prefs.autoFetchFavicons !== false,
        (v) => apply({ autoFetchFavicons: v }),
        'Downloads the icon when you save an entry with a web address, and keeps ' +
          'it in the database so it is there offline. Fetching it tells that site ' +
          'somebody here has an entry for it.'
      ),
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
        h('button', { class: 'btn ghost small', text: tr('Updates...'), onClick: () => openUpdates() })
      )
    );
  }

  function pageLocking(prefs) {
    return h(
      'div',
      null,
      numberField('Lock after inactivity', prefs.autoLockMinutes, 0, 240, 'minutes (0 to never)', (v) =>
        apply({ autoLockMinutes: v })
      ),
      toggle('Lock when the window is minimised', prefs.lockOnMinimize, (v) => apply({ lockOnMinimize: v })),
      toggle('Lock when Windows sleeps or locks', prefs.lockOnSuspend, (v) => apply({ lockOnSuspend: v })),
      toggle('Hide passwords until revealed', prefs.concealPasswords !== false, (v) => apply({ concealPasswords: v }))
    );
  }

  function pageAppearance(prefs) {
    return h('div', null, appearanceField(prefs), themeField(prefs));
  }

  function pageAccessibility(prefs) {
    return h(
      'div',
      null,
      selectField(
        'Typeface',
        [
          { value: 'system', label: tr('System default') },
          { value: 'dyslexic', label: tr('OpenDyslexic (for dyslexia)') },
          { value: 'hyperlegible', label: tr('Atkinson Hyperlegible (for low vision)') }
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
        text: tr('Out of the box only the colourblind safe palette is on. Everything else here starts off.')
      }),
      h(
        'div',
        { class: 'row-gap' },
        h('button', {
          class: 'btn ghost small',
          text: tr('Reset accessibility to defaults'),
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
            toast(tr('Accessibility settings reset'), 'good');
            reopenSettings();
          }
        })
      )
    );
  }

  async function pageSecurity(prefs) {
    const wrap = h('div', null);
    const capture = await screenCaptureSection();
    if (capture) wrap.append(capture);
    const warning = await clipboardWarning();
    if (warning) wrap.append(warning);

    wrap.append(
      h('div', { class: 'detail-section' }, h('h3', { text: tr('YubiKey') })),
      h('p', {
        class: 'hint warning',
        text:
          tr('Unlocking with a YubiKey is written but has never been run against a real ') +
          'key, so compatibility is not guaranteed. It stays off until you turn it on. ' +
          'If you do, test your key before binding a database to it, and keep a backup: ' +
          'a database bound to a key that does not work cannot be opened.'
      }),
      toggle('Allow unlocking with a YubiKey (beta)', prefs.yubikeyBeta === true, async (v) => {
        if (v) {
          const ok = await IV.api.confirm({
            title: tr('Turn on YubiKey support'),
            message: 'This part of the app has never been tested against real hardware.',
            detail:
              'Everything that could be checked without a key was checked, but every ' +
              'code path that talks to a device is unproven. Test your key before you ' +
              'bind a database to it, and back the database up first.',
            confirmLabel: tr('Turn it on'),
            destructive: true
          });
          if (!ok) {
            reopenSettings();
            return;
          }
        }
        await apply({ yubikeyBeta: v });
        reopenSettings();
      })
    );
    return wrap;
  }

  async function pageConnections() {
    const wrap = h('div', null);
    for (const build of [aliasSection, browserSection, lanSection]) {
      const section = await build();
      if (section) wrap.append(section);
    }
    return wrap;
  }

  const SETTINGS_PAGES = [
    { id: 'general', label: tr('General'), build: (prefs) => pageGeneral(prefs) },
    { id: 'locking', label: tr('Locking'), build: (prefs) => pageLocking(prefs) },
    { id: 'security', label: tr('Security'), build: (prefs) => pageSecurity(prefs) },
    { id: 'connections', label: tr('Connections'), build: () => pageConnections() },
    { id: 'appearance', label: tr('Appearance'), build: (prefs) => pageAppearance(prefs) },
    { id: 'accessibility', label: tr('Accessibility'), build: (prefs) => pageAccessibility(prefs) },
    { id: 'database', label: tr('This database'), build: (prefs, info) => pageDatabase(info) }
  ];

  async function openSettings(page) {
    const prefs = IV.state.prefs;
    const info = IV.state.info;
    if (page) settingsPage = page;

    const pane = h('div', { class: 'settings-pane' });
    const nav = h('div', { class: 'settings-nav', role: 'tablist' });

    async function show(id) {
      settingsPage = id;
      for (const button of nav.children) {
        const on = button.dataset.page === id;
        button.classList.toggle('on', on);
        button.setAttribute('aria-selected', on ? 'true' : 'false');
      }
      IV.dom.clear(pane);
      const chosen = SETTINGS_PAGES.find((entry) => entry.id === id) || SETTINGS_PAGES[0];
      pane.append(await chosen.build(prefs, info));
      pane.scrollTop = 0;
    }

    for (const entry of SETTINGS_PAGES) {
      nav.append(
        h('button', {
          class: 'settings-tab',
          role: 'tab',
          text: entry.label,
          dataset: { page: entry.id },
          onClick: () => show(entry.id)
        })
      );
    }

    const handle = modal({
      title: tr('Settings'),
      body: h('div', { class: 'settings-layout' }, nav, pane),
      footer: [h('button', { class: 'btn primary', text: tr('Done'), onClick: () => handle.close() })]
    });

    await show(settingsPage);
    return handle;
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

  /**
   * Updating, as one action rather than a form.
   *
   * The old version put four buttons and the whole feed configuration at the
   * same weight, so the one thing somebody came to do sat beside a text box
   * explaining latest.yml. What is in front of you now is the update; the
   * settings are behind Advanced, where they are wanted about once.
   *
   * Downloading and installing were also two presses with a wait between them,
   * which is one press too many for something the user already said yes to.
   * Update now does both: it downloads, then installs when the download lands.
   */
  let updatesHandle = null;
  let autoInstall = false;

  function openUpdates() {
    // Only ever one of these. A second dialog left the first one live but
    // unlistened to, so pressing Download on it did nothing visible while the
    // download actually ran behind it.
    if (updatesHandle && typeof updatesHandle.close === 'function') {
      try {
        updatesHandle.close();
      } catch {
        /* already gone */
      }
    }
    autoInstall = false;

    const prefs = IV.state.prefs;
    const headline = h('p', { class: 'update-headline' });
    const detail = h('p', { class: 'hint' });
    const bar = h('div', { class: 'progress', hidden: true }, h('div', { class: 'progress-fill' }));
    const actions = h('div', { class: 'row-gap' });
    const notes = h('div', { class: 'notes-box', hidden: true });

    const feedInput = h('input', {
      type: 'text',
      value: prefs.updateFeedUrl || '',
      spellcheck: 'false',
      placeholder: tr('https://example.com/propolis/updates/'),
      onChange: () => apply({ updateFeedUrl: feedInput.value.trim() })
    });
    const pageInput = h('input', {
      type: 'text',
      value: prefs.updateReleasePageUrl || '',
      spellcheck: 'false',
      placeholder: tr('https://example.com/propolis/releases'),
      onChange: () => apply({ updateReleasePageUrl: pageInput.value.trim() })
    });

    async function install(update) {
      const ok = await IV.api.confirm({
        title: tr('Install update'),
        message: 'Install version ' + update.version + ' and restart Propolis?',
        detail: 'Any open database is locked first. Unsaved changes are saved automatically.',
        confirmLabel: tr('Install and restart')
      });
      if (!ok) return;
      await IV.api.lock().catch(() => {});
      await IV.api.installUpdate();
    }

    function render(update) {
      IV.state.update = update;
      headline.textContent = describe(update);
      headline.className = 'update-headline' + (update.status === 'error' ? ' error-line' : '');

      detail.textContent =
        update.status === 'available'
          ? 'It downloads and installs in one go. Propolis restarts when it is done.'
          : update.status === 'ready'
            ? 'Ready to install.'
            : '';
      detail.hidden = !detail.textContent;

      bar.hidden = update.status !== 'downloading';
      bar.firstChild.style.width = (update.percent || 0) + '%';

      if (update.notes) {
        notes.hidden = false;
        notes.textContent = String(update.notes).replace(/<[^>]+>/g, '').trim();
      } else {
        notes.hidden = true;
      }

      // The download finishing is what triggers the install, so Update now is
      // one press rather than two with a wait in between.
      if (update.status === 'ready' && autoInstall) {
        autoInstall = false;
        install(update);
      }

      IV.dom.clear(actions);

      if (update.status === 'available') {
        IV.dom.add(
          actions,
          h('button', {
            class: 'btn primary',
            text: tr('Update now'),
            onClick: async () => {
              autoInstall = true;
              try {
                await IV.api.downloadUpdate();
              } catch (err) {
                autoInstall = false;
                toast(err.message, 'error');
              }
            }
          }),
          h('button', {
            class: 'btn ghost small',
            text: tr('Skip this version'),
            onClick: async () => {
              await apply({ skippedUpdateVersion: update.version });
              toast(tr('Propolis will not bring up ') + update.version + ' again');
              handle.close();
            }
          }),
          prefs.updateReleasePageUrl
            ? h('button', {
                class: 'btn ghost small',
                text: "What's new",
                onClick: () => IV.api.openReleasePage().catch((err) => toast(err.message, 'error'))
              })
            : null
        );
        return;
      }

      if (update.status === 'downloading') {
        IV.dom.add(actions, h('button', { class: 'btn primary', text: tr('Downloading...'), disabled: true }));
        return;
      }

      if (update.status === 'ready') {
        IV.dom.add(
          actions,
          h('button', { class: 'btn primary', text: tr('Restart and install'), onClick: () => install(update) })
        );
        return;
      }

      IV.dom.add(
        actions,
        h('button', {
          class: 'btn ' + (update.status === 'error' ? 'primary' : 'ghost') + ' small',
          text: update.status === 'checking' ? 'Checking...' : update.status === 'error' ? 'Try again' : 'Check now',
          disabled: update.status === 'checking',
          onClick: async () => {
            try {
              render(await IV.api.checkUpdates(true));
            } catch (err) {
              toast(err.message, 'error');
            }
          }
        })
      );
    }

    const advanced = h(
      'details',
      { class: 'adv' },
      h('summary', { text: tr('Advanced') }),
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: tr('Update feed URL') }), feedInput),
      h(
        'div',
        { class: 'row-gap' },
        h('button', {
          class: 'btn ghost small',
          text: tr('Use the Propolis repository'),
          onClick: async () => {
            const state = await IV.api.updateState();
            feedInput.value = state.defaultFeedUrl;
            await apply({ updateFeedUrl: state.defaultFeedUrl });
            toast(tr('Feed reset to the Propolis repository'), 'good');
          }
        }),
        h('button', {
          class: 'btn ghost small',
          text: tr('Never check'),
          onClick: async () => {
            feedInput.value = '';
            await apply({ updateFeedUrl: '' });
            render(await IV.api.updateState());
            toast(tr('Update checks turned off'));
          }
        })
      ),
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: tr('Release notes page') }), pageInput),
      h('p', {
        class: 'hint',
        text:
          tr('A check asks for latest.yml beside the installer, so a release published ') +
          'without that file cannot be seen however public the repository is. Leave ' +
          'the feed empty and Propolis never contacts anything.'
      })
    );

    const handle = modal({
      title: tr('Updates'),
      body: h(
        'div',
        null,
        headline,
        detail,
        bar,
        actions,
        notes,
        h('div', { class: 'detail-section' }),
        toggle('Check automatically when Propolis starts', prefs.autoCheckUpdates, (v) =>
          apply({ autoCheckUpdates: v })
        ),
        advanced
      ),
      footer: [h('button', { class: 'btn primary', text: tr('Done'), onClick: () => handle.close() })],
      onClose: () => {
        liveUpdatePanel = null;
        updatesHandle = null;
        autoInstall = false;
        clearInterval(poll);
      }
    });

    updatesHandle = handle;
    liveUpdatePanel = render;

    // Asked for as well as listened for. Progress arrives by event, and an event
    // that goes astray used to leave this sitting on a stale screen with no way
    // to recover except closing it.
    const poll = setInterval(() => {
      IV.api.updateState().then(render).catch(() => {});
    }, 1000);

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
  let pendingUpdate = null;
  let pendingTimer = null;

  /**
   * Holds an update back rather than throwing it away.
   *
   * The check runs about eight seconds after launch, which is roughly when
   * somebody is typing their master password, so something is usually open.
   * Refusing to interrupt was right; dropping the news entirely was not, and
   * that is what happened: the next automatic check is a day later, so the
   * prompt never appeared and the update had to be found by hand.
   *
   * It waits for the way to be clear and then says its piece.
   */
  function promptForUpdate(update) {
    if (!update || update.status !== 'available' || !update.version) return;
    if (update.version === (IV.state.prefs.skippedUpdateVersion || null)) return;
    if (updatePromptedFor === update.version) return;
    pendingUpdate = update;
    showPendingUpdate();
  }

  function showPendingUpdate() {
    if (!pendingUpdate) return;

    // Still busy. Come back shortly rather than giving up.
    if (IV.dom.topModal && IV.dom.topModal()) {
      if (!pendingTimer) pendingTimer = setInterval(showPendingUpdate, 4000);
      return;
    }

    if (pendingTimer) {
      clearInterval(pendingTimer);
      pendingTimer = null;
    }
    const update = pendingUpdate;
    pendingUpdate = null;
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
      title: tr('Keyboard shortcuts'),
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
      title: tr('About Propolis'),
      body: h(
        'div',
        null,
        h('p', { text: tr('Propolis ') + app.version }),
        h('p', {
          class: 'muted',
          text: tr('A KeePass client for Windows. Reads and writes KDBX 3.1 and KDBX 4 files with AES or ChaCha20 and Argon2 or AES-KDF.')
        }),
        h('div', { class: 'detail-section' }, h('h3', { text: tr('How your data is handled') })),
        h('ul', { class: 'muted' },
          h('li', { text: tr('Everything stays in the .kdbx file you chose. Nothing is uploaded anywhere.') }),
          h('li', { text: tr('The app has no network access at all.') }),
          h('li', { text: tr('Passwords are only decrypted when you ask to see or copy one.') }),
          h('li', { text: tr('Quick unlock stores the master password with Windows DPAPI, tied to your Windows account.') })
        ),
        h('p', { class: 'muted', text: tr('Electron ') + app.electron })
      )
    });
  }

  IV.settings = { openSettings, openShortcuts, openAbout, openUpdates, onUpdateState, promptForUpdate };
})(window.IV);
