/* Password, passphrase, and username generator. */
window.IV = window.IV || {};

(function (IV) {
  'use strict';

  const { h, clear, toast, modal } = IV.dom;

  const LATIN1_RE = /[¡-ÿ]/;

  /** Splits a password into runs of one character class so each can be tinted. */
  function classOf(character) {
    if (character >= 'A' && character <= 'Z') return 'upper';
    if (character >= 'a' && character <= 'z') return 'lower';
    if (character >= '0' && character <= '9') return 'digit';
    if (LATIN1_RE.test(character)) return 'latin1';
    if (character === ' ') return 'space';
    return 'symbol';
  }

  function colorize(password, node) {
    clear(node);
    if (!password) {
      node.append(h('span', { class: 'gen-empty', text: 'Nothing generated' }));
      return;
    }
    let run = '';
    let runClass = null;
    const flush = () => {
      if (!run) return;
      node.append(h('span', { class: 'pw-' + runClass, text: run }));
      run = '';
    };
    for (const character of password) {
      const kind = classOf(character);
      if (kind !== runClass) {
        flush();
        runClass = kind;
      }
      run += character;
    }
    flush();
  }

  /** Names the colours in the preview, so they are labelled and not just hues. */
  function legend() {
    return h(
      'div',
      { class: 'pw-legend' },
      [
        ['upper', 'A', 'uppercase'],
        ['lower', 'a', 'lowercase'],
        ['digit', '1', 'digits'],
        ['symbol', '#', 'symbols'],
        ['latin1', 'ä', 'Latin-1']
      ].map(([cls, glyph, label]) =>
        h('span', null, h('b', { class: 'pw-' + cls, text: glyph }), h('span', { text: label }))
      )
    );
  }

  function strengthLine(estimate) {
    return h('div', { class: 'strength-row' }, IV.dom.strengthMeter(estimate), IV.glossary.badge('entropy'));
  }

  /* ------------------------------------------------------------- controls */

  function checkbox(label, checked, onChange, hint) {
    const input = h('input', { type: 'checkbox', checked, onChange: () => onChange(input.checked) });
    const row = h(
      'label',
      { class: 'checkline' },
      input,
      h('span', null, h('span', { text: label }), hint ? h('small', { class: 'checkhint', text: hint }) : null)
    );
    return { input, row };
  }

  function slider(label, value, min, max, onChange) {
    const input = h('input', {
      type: 'range',
      min: String(min),
      max: String(max),
      value: String(value),
      onInput: () => {
        box.value = input.value;
        onChange(Number(input.value));
      }
    });
    const box = h('input', {
      type: 'number',
      class: 'num-box',
      min: String(min),
      max: String(max),
      value: String(value),
      onChange: () => {
        const clamped = Math.max(min, Math.min(max, Number(box.value) || min));
        box.value = String(clamped);
        input.value = String(clamped);
        onChange(clamped);
      }
    });
    const sync = (v) => {
      input.value = String(v);
      box.value = String(v);
    };
    return {
      sync,
      row: h(
        'div',
        { class: 'field' },
        h('span', { class: 'field-label', text: label }),
        h('div', { class: 'range-row' }, input, box)
      )
    };
  }

  function select(label, options, value, onChange) {
    const el = h(
      'select',
      { onChange: () => onChange(el.value) },
      options.map((o) => h('option', { value: o.value, selected: o.value === value, text: o.label }))
    );
    return h('label', { class: 'field' }, h('span', { class: 'field-label', text: label }), el);
  }

  function wordListSelect(catalogue, value, onChange) {
    const groups = [
      ['standard', 'Standard'],
      ['fandom', 'Fandom'],
      ['languages', 'Languages']
    ];
    const el = h('select', { onChange: () => onChange(el.value) });
    for (const [key, title] of groups) {
      const items = catalogue.filter((c) => c.category === key);
      if (!items.length) continue;
      el.append(
        h(
          'optgroup',
          { label: title },
          items.map((item) =>
            h('option', { value: item.key, selected: item.key === value, text: item.name })
          )
        )
      );
    }
    return el;
  }

  /* ------------------------------------------------------------ the modal */

  /**
   * `mode` opens on a given tab without that counting as a choice. A master
   * password is typed from memory, so those callers ask for Diceware even when
   * the saved preference is Basic, and the preference is left as it was.
   */
  function openGenerator({ onUse, title, mode: openOn } = {}) {
    const catalogue = IV.state.wordLists || [];
    const config = JSON.parse(JSON.stringify(IV.state.prefs.generator || {}));
    const savedAlgorithm = config.algorithm === 'diceware' ? 'diceware' : 'basic';
    let chosenByHand = !openOn;
    let current = '';
    let mode = openOn === 'diceware' || openOn === 'basic' ? openOn : savedAlgorithm;

    const previewText = h('div', { class: 'gen-preview-text' });
    const preview = h(
      'div',
      { class: 'gen-preview' },
      previewText,
      h(
        'div',
        { class: 'gen-preview-actions' },
        h('button', {
          class: 'icon-btn refresh',
          title: 'Generate another',
          onClick: () => regenerate()
        }),
        h('button', {
          class: 'icon-btn copy',
          title: 'Copy to the clipboard',
          onClick: async () => {
            if (!current) return;
            await IV.api.copy(current);
            toast('Password copied');
          }
        })
      )
    );
    const meter = h('div', { class: 'gen-meter' });
    const listInfo = h('p', { class: 'hint' });
    const colourKey = legend();

    let pending = null;
    async function regenerate() {
      if (pending) clearTimeout(pending);
      pending = setTimeout(async () => {
        try {
          const result = await IV.api.generate({ ...config, algorithm: mode });
          current = result.password;
          colorize(current, previewText);
          clear(meter).append(strengthLine(result.strength));
          if (mode === 'diceware') {
            listInfo.textContent =
              result.poolSize.toLocaleString() + ' words in the list, ' + result.bitsPerWord + ' bits per word';
          } else {
            listInfo.textContent = result.poolSize + ' characters available';
          }
        } catch (err) {
          current = '';
          clear(previewText).append(h('span', { class: 'gen-error', text: err.message }));
          clear(meter);
        }
      }, 10);
    }

    /* ---- basic panel ---- */

    const lengthSlider = slider('Length', config.length, 6, 128, (v) => {
      config.length = v;
      regenerate();
    });

    const groupBoxes = [
      ['upper', 'ABC Uppercase Characters'],
      ['lower', 'abc Lowercase Characters'],
      ['digits', '123 Numeric'],
      ['symbols', '$&#= Symbols'],
      ['latin1', 'áöü Latin-1 Supplement']
    ].map(([key, label]) =>
      checkbox(label, config.groups[key], (v) => {
        config.groups[key] = v;
        regenerate();
      })
    );

    const excludedInput = h('input', {
      type: 'text',
      value: config.excludedCharacters || '',
      placeholder: 'none',
      spellcheck: 'false',
      onInput: () => {
        config.excludedCharacters = excludedInput.value;
        regenerate();
      }
    });

    const basicAdvanced = h(
      'details',
      { class: 'adv' },
      h('summary', { text: 'Advanced' }),
      checkbox(
        'Easy Read Characters Only',
        config.easyReadOnly,
        (v) => {
          config.easyReadOnly = v;
          regenerate();
        },
        'Exclude lookalike characters (e.g. | 1 l 0 o O)'
      ).row,
      checkbox(
        'Non-Ambiguous Characters Only',
        config.nonAmbiguousOnly,
        (v) => {
          config.nonAmbiguousOnly = v;
          regenerate();
        },
        'Exclude ambiguous characters (e.g. { } [ ] ( ) / \\ \' ")'
      ).row,
      checkbox(
        'Pick Characters From Every Group',
        config.pickFromEveryGroup,
        (v) => {
          config.pickFromEveryGroup = v;
          regenerate();
        },
        'Include at least one character from each group'
      ).row,
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Excluded Characters' }), excludedInput)
    );

    const basicPanel = h(
      'div',
      null,
      lengthSlider.row,
      h('div', { class: 'gen-grid' }, groupBoxes.map((b) => b.row)),
      basicAdvanced
    );

    /* ---- diceware panel ---- */

    const wordSlider = slider('Words', config.wordCount, 1, 16, (v) => {
      config.wordCount = v;
      regenerate();
    });

    const listSelect = wordListSelect(catalogue, (config.wordLists || [])[0] || 'eff-large', (v) => {
      config.wordLists = [v];
      regenerate();
    });

    const separatorInput = h('input', {
      type: 'text',
      value: config.separator,
      maxlength: '5',
      placeholder: 'none',
      onInput: () => {
        config.separator = separatorInput.value;
        regenerate();
      }
    });

    const addBoxes = [
      ['addNumber', 'Add a number'],
      ['addUppercase', 'Add an uppercase character'],
      ['addLowercase', 'Add a lowercase character'],
      ['addSymbol', 'Add a symbol'],
      ['addLatin1', 'Add a Latin-1 character']
    ].map(([key, label]) =>
      checkbox(label, config[key], (v) => {
        config[key] = v;
        regenerate();
      })
    );

    const dicewareAdvanced = h(
      'details',
      { class: 'adv' },
      h('summary', { text: 'Advanced' }),
      select(
        'Casing',
        [
          { value: 'none', label: 'Do Not Change' },
          { value: 'lower', label: 'lowercase' },
          { value: 'upper', label: 'UPPERCASE' },
          { value: 'title', label: 'Title Case' },
          { value: 'random', label: 'rAnDom' }
        ],
        config.casing,
        (v) => {
          config.casing = v;
          regenerate();
        }
      ),
      h('div', { class: 'gen-grid' }, addBoxes.map((b) => b.row)),
      select(
        'Leetspeak (e.g. l33t, 1337)',
        [
          { value: 'none', label: 'None' },
          { value: 'basic-some', label: 'Basic (some words)' },
          { value: 'basic-all', label: 'Basic (all words)' },
          { value: 'pro-some', label: 'Pro (some words)' },
          { value: 'pro-all', label: 'Pro (all words)' }
        ],
        config.leetspeak,
        (v) => {
          config.leetspeak = v;
          regenerate();
        }
      ),
      select(
        'Add Salt',
        [
          { value: 'none', label: 'None' },
          { value: 'prefix', label: 'Prefix' },
          { value: 'sprinkle', label: 'Sprinkle' },
          { value: 'suffix', label: 'Suffix' }
        ],
        config.salt,
        (v) => {
          config.salt = v;
          regenerate();
        }
      )
    );

    const dicewarePanel = h(
      'div',
      { hidden: true },
      wordSlider.row,
      h('label', { class: 'field' }, IV.glossary.label('Word list', 'wordlist'), listSelect),
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Separator' }), separatorInput),
      dicewareAdvanced
    );

    /* ---- tabs ---- */

    const tabBasic = h('button', { class: 'tab', text: 'Basic', onClick: () => setMode('basic', true) });
    const tabDiceware = h('button', { class: 'tab', text: 'Diceware', onClick: () => setMode('diceware', true) });
    const tabHelp = IV.glossary.badge('diceware', { label: 'What is Diceware?' });

    function setMode(next, byHand) {
      mode = next;
      config.algorithm = next;
      if (byHand) chosenByHand = true;
      tabBasic.classList.toggle('active', next === 'basic');
      tabDiceware.classList.toggle('active', next === 'diceware');
      basicPanel.hidden = next !== 'basic';
      dicewarePanel.hidden = next !== 'diceware';
      regenerate();
    }

    const handle = modal({
      title: title || 'Password generator',
      wide: true,
      body: h(
        'div',
        null,
        h('div', { class: 'tab-row' }, h('div', { class: 'tabs' }, tabBasic, tabDiceware), tabHelp),
        preview,
        colourKey,
        meter,
        listInfo,
        h('div', { class: 'gen-panels' }, basicPanel, dicewarePanel)
      ),
      footer: [
        h('span', { class: 'spacer' }),
        onUse
          ? h('button', {
              class: 'btn primary',
              text: 'Use this',
              onClick: () => {
                if (!current) return;
                onUse(current);
                handle.close();
              }
            })
          : null
      ].filter(Boolean),
      onClose: () => {
        const saved = { ...config, algorithm: chosenByHand ? config.algorithm : savedAlgorithm };
        IV.api
          .setPrefs({ generator: saved })
          .then((p) => {
            IV.state.prefs = p;
          })
          .catch(() => {});
      }
    });

    setMode(mode);
    return handle;
  }

  /* ------------------------------------------------------ username picker */

  function openUsernamePicker({ onUse } = {}) {
    const list = h('div', { class: 'suggest-list' });

    async function refresh() {
      try {
        const suggestions = await IV.api.usernames();
        clear(list);
        for (const suggestion of suggestions) {
          list.append(
            h(
              'button',
              {
                class: 'suggest-row',
                onClick: () => {
                  if (onUse) onUse(suggestion.value);
                  handle.close();
                }
              },
              h('span', { class: 'suggest-value', text: suggestion.value }),
              h('span', { class: 'suggest-type', text: suggestion.type })
            )
          );
        }
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    const handle = modal({
      title: 'Suggested usernames',
      body: h('div', null, h('p', { class: 'hint', text: 'Pick one, or shuffle for a new set.' }), list),
      footer: [
        h('button', { class: 'btn ghost', text: 'Shuffle', onClick: refresh }),
        h('button', { class: 'btn primary', text: 'Close', onClick: () => handle.close() })
      ]
    });

    refresh();
    return handle;
  }

  IV.generator = { openGenerator, openUsernamePicker, colorize, strengthLine, classOf };
})(window.IV);
