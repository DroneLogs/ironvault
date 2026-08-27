/* Entry editor, group editor, and the master key dialog. */
window.IV = window.IV || {};

(function (IV) {
  'use strict';

  const { h, clear, toast, modal, strengthMeter } = IV.dom;

  function flattenGroups(group, depth, acc) {
    if (!group.isRecycleBin) {
      acc.push({ id: group.id, name: ' '.repeat(depth * 3) + (depth ? '' : '') + group.name, depth });
      for (const child of group.groups) flattenGroups(child, depth + 1, acc);
    }
    return acc;
  }

  function groupOptions(selectedId) {
    const flat = flattenGroups(IV.state.tree.root, 0, []);
    return flat.map((g) =>
      h('option', { value: g.id, selected: g.id === selectedId, text: g.name })
    );
  }

  /* ------------------------------------------------------------ entry editor */

  async function openEntryEditor(entryOrNull, defaultGroupId) {
    const isNew = !entryOrNull;
    const entry = entryOrNull || {
      title: '',
      username: '',
      url: '',
      notes: '',
      tags: [],
      customFields: [],
      expires: false,
      expiryTime: null,
      groupId: defaultGroupId
    };

    let passwordValue = '';
    if (!isNew && entry.hasPassword) {
      try {
        passwordValue = await IV.api.secret(entry.id, 'Password');
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    const titleInput = h('input', { type: 'text', value: entry.title || '', placeholder: 'Required' });
    const userInput = h('input', { type: 'text', value: entry.username || '', spellcheck: 'false' });
    const userSuggestBtn = h('button', {
      type: 'button',
      class: 'icon-btn dice',
      title: 'Suggest a username',
      onClick: () =>
        IV.generator.openUsernamePicker({
          onUse: (value) => {
            userInput.value = value;
          }
        })
    });
    const urlInput = h('input', { type: 'text', value: entry.url || '', spellcheck: 'false', placeholder: 'https://' });
    const notesInput = h('textarea', { value: entry.notes || '' });
    let tags = (entry.tags || []).slice();
    const tagChips = h('div', { class: 'tag-row' });
    const tagList = h('datalist', { id: 'iv-tag-suggestions' });
    const tagInput = h('input', {
      type: 'text',
      list: 'iv-tag-suggestions',
      placeholder: 'Add a tag and press Enter',
      onKeydown: (e) => {
        if (e.key === 'Enter' || e.key === ',') {
          e.preventDefault();
          addTag(tagInput.value);
        } else if (e.key === 'Backspace' && !tagInput.value && tags.length) {
          tags.pop();
          refreshTags();
        }
      },
      onChange: () => addTag(tagInput.value),
      onBlur: () => addTag(tagInput.value)
    });

    IV.api
      .allTags()
      .then((all) => {
        clear(tagList);
        for (const tag of all) tagList.append(h('option', { value: tag }));
      })
      .catch(() => {});

    const passInput = h('input', {
      type: 'password',
      value: passwordValue,
      spellcheck: 'false',
      autocomplete: 'off',
      onInput: refreshStrength
    });
    const meter = h('div');

    let strengthTimer = null;
    function refreshStrength() {
      if (strengthTimer) clearTimeout(strengthTimer);
      strengthTimer = setTimeout(async () => {
        const estimate = await IV.api.strength(passInput.value);
        clear(meter);
        if (passInput.value) meter.append(strengthMeter(estimate));
      }, 120);
    }

    function refreshTags() {
      clear(tagChips);
      for (const tag of tags) {
        tagChips.append(
          h(
            'span',
            { class: 'tag chip' },
            h('span', { text: tag }),
            h('button', {
              type: 'button',
              class: 'chip-x',
              title: 'Remove tag',
              onClick: () => {
                tags = tags.filter((t) => t !== tag);
                refreshTags();
              }
            })
          )
        );
      }
    }

    function addTag(value) {
      const clean = String(value || '').trim().replace(/,+$/, '');
      if (!clean) return;
      if (!tags.some((t) => t.toLowerCase() === clean.toLowerCase())) tags.push(clean);
      tagInput.value = '';
      refreshTags();
    }

    const revealBtn = h('button', {
      type: 'button',
      class: 'icon-btn reveal',
      title: 'Show password',
      onClick: () => {
        const showing = passInput.type === 'text';
        passInput.type = showing ? 'password' : 'text';
        revealBtn.classList.toggle('on', !showing);
      }
    });

    const genBtn = h('button', {
      type: 'button',
      class: 'icon-btn dice',
      title: 'Generate',
      onClick: () =>
        IV.generator.openGenerator({
          onUse: (value) => {
            passInput.value = value;
            refreshStrength();
          }
        })
    });

    /* custom fields */
    const fieldsWrap = h('div');
    const fieldRows = [];

    function addFieldRow(field) {
      const state = {
        key: field.key || '',
        value: field.value || '',
        protected: Boolean(field.protected),
        unchanged: Boolean(field.protected) && !field.isNew
      };

      const keyInput = h('input', {
        type: 'text',
        class: 'key',
        value: state.key,
        placeholder: 'Name',
        onInput: () => {
          state.key = keyInput.value;
        }
      });

      const valueInput = h('input', {
        type: state.protected ? 'password' : 'text',
        class: 'value',
        value: state.value,
        placeholder: state.unchanged ? 'unchanged' : '',
        onInput: () => {
          state.value = valueInput.value;
          state.unchanged = false;
          valueInput.placeholder = '';
        }
      });

      const protectBtn = h('button', {
        type: 'button',
        class: 'icon-btn lock' + (state.protected ? ' on' : ''),
        title: state.protected ? 'Stored encrypted' : 'Stored in the clear',
        onClick: async () => {
          if (state.protected && state.unchanged) {
            // Reveal the stored value before turning protection off, so the
            // user does not silently blank the field.
            try {
              state.value = await IV.api.secret(entry.id, state.key);
              valueInput.value = state.value;
              state.unchanged = false;
            } catch {
              /* leave it as is */
            }
          }
          state.protected = !state.protected;
          valueInput.type = state.protected ? 'password' : 'text';
          protectBtn.classList.toggle('on', state.protected);
          protectBtn.title = state.protected ? 'Stored encrypted' : 'Stored in the clear';
        }
      });
      if (state.protected) protectBtn.style.setProperty('color', 'var(--accent)');

      const row = h(
        'div',
        { class: 'custom-field-row' },
        keyInput,
        valueInput,
        protectBtn,
        h('button', {
          type: 'button',
          class: 'icon-btn trash',
          title: 'Remove field',
          onClick: () => {
            row.remove();
            const index = fieldRows.indexOf(record);
            if (index >= 0) fieldRows.splice(index, 1);
          }
        })
      );

      const record = { state, row };
      fieldRows.push(record);
      fieldsWrap.append(row);
    }

    for (const field of entry.customFields || []) addFieldRow(field);

    /* expiry */
    const expiresCheck = h('input', {
      type: 'checkbox',
      checked: Boolean(entry.expires),
      onChange: () => {
        expiryDate.disabled = !expiresCheck.checked;
      }
    });
    const expiryDate = h('input', {
      type: 'date',
      disabled: !entry.expires,
      value: entry.expiryTime ? new Date(entry.expiryTime).toISOString().slice(0, 10) : ''
    });

    const groupSelect = h('select', null, groupOptions(entry.groupId || defaultGroupId));

    const body = h(
      'div',
      null,
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Title' }), titleInput),
      h(
        'div',
        { class: 'field' },
        h('span', { class: 'field-label', text: 'Username' }),
        h('span', { class: 'input-with-action' }, userInput, userSuggestBtn)
      ),
      h(
        'div',
        { class: 'field' },
        h('span', { class: 'field-label', text: 'Password' }),
        h('span', { class: 'input-with-action' }, passInput, revealBtn, genBtn),
        meter
      ),
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'URL' }), urlInput),
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Notes' }), notesInput),
      h(
        'div',
        { class: 'field' },
        h('span', { class: 'field-label', text: 'Tags' }),
        tagChips,
        tagInput,
        tagList
      ),
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Group' }), groupSelect),
      h(
        'div',
        { class: 'field' },
        h('span', { class: 'field-label', text: 'Expiry' }),
        h(
          'div',
          { class: 'row-gap' },
          h('label', { class: 'checkline' }, expiresCheck, h('span', { text: 'Expires on' })),
          expiryDate
        )
      ),
      h(
        'div',
        { class: 'detail-section' },
        h('h3', { text: 'Custom fields' }),
        fieldsWrap,
        h('button', {
          type: 'button',
          class: 'btn ghost small',
          text: 'Add field',
          onClick: () => addFieldRow({ key: '', value: '', protected: false, isNew: true })
        }),
        h('p', {
          class: 'hint',
          text: 'A field named otp holding an otpauth:// URI becomes a one time code.'
        })
      )
    );

    let saving = false;

    async function submit() {
      if (saving) return;
      if (!titleInput.value.trim()) {
        toast('A title is required', 'error');
        titleInput.focus();
        return;
      }
      addTag(tagInput.value);
      saving = true;
      const payload = {
        title: titleInput.value.trim(),
        username: userInput.value,
        password: passInput.value,
        url: urlInput.value.trim(),
        notes: notesInput.value,
        tags: tags.slice(),
        groupId: groupSelect.value,
        expires: expiresCheck.checked,
        expiryTime: expiresCheck.checked && expiryDate.value ? new Date(expiryDate.value + 'T23:59:59').getTime() : null,
        customFields: fieldRows
          .filter((r) => r.state.key.trim())
          .map((r) => ({
            key: r.state.key.trim(),
            value: r.state.value,
            protected: r.state.protected,
            unchanged: r.state.unchanged
          }))
      };

      try {
        let saved;
        if (isNew) {
          saved = await IV.api.createEntry(payload);
        } else {
          saved = await IV.api.updateEntry({ id: entry.id, ...payload });
          if (payload.groupId && payload.groupId !== entry.groupId) {
            await IV.api.moveEntry(entry.id, payload.groupId);
          }
        }
        handle.close();
        await IV.app.refresh({ selectEntryId: saved.id });
        await IV.app.autoSave();
        toast(isNew ? 'Entry created' : 'Entry saved', 'good');
      } catch (err) {
        saving = false;
        toast(err.message, 'error');
      }
    }

    const handle = modal({
      title: isNew ? 'New entry' : 'Edit entry',
      wide: true,
      body,
      footer: [
        h('button', { class: 'btn ghost', text: 'Cancel', onClick: () => handle.close() }),
        h('button', { class: 'btn primary', text: isNew ? 'Create' : 'Save', onClick: submit })
      ]
    });

    body.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit();
    });

    titleInput.focus();
    refreshStrength();
    refreshTags();
    return handle;
  }

  /* ------------------------------------------------------------ group editor */

  function openGroupEditor(groupOrNull, parentId) {
    const isNew = !groupOrNull;
    const nameInput = h('input', { type: 'text', value: isNew ? '' : groupOrNull.name });
    const notesInput = h('textarea', { value: isNew ? '' : groupOrNull.notes || '' });
    const parentSelect = isNew ? null : h('select', null, groupOptions(null));

    async function submit() {
      const name = nameInput.value.trim();
      if (!name) {
        toast('A name is required', 'error');
        return;
      }
      try {
        if (isNew) await IV.api.createGroup(parentId, name);
        else await IV.api.updateGroup({ id: groupOrNull.id, name, notes: notesInput.value });
        handle.close();
        await IV.app.refresh();
        await IV.app.autoSave();
        toast(isNew ? 'Group created' : 'Group saved', 'good');
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    const handle = modal({
      title: isNew ? 'New group' : 'Edit group',
      body: h(
        'div',
        null,
        h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Name' }), nameInput),
        h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Notes' }), notesInput)
      ),
      footer: [
        h('button', { class: 'btn ghost', text: 'Cancel', onClick: () => handle.close() }),
        h('button', { class: 'btn primary', text: isNew ? 'Create' : 'Save', onClick: submit })
      ]
    });

    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
    return handle;
  }

  /* -------------------------------------------------------- master key dialog */

  /**
   * Changing the master key. The reminder that asks every so often lands here
   * too, and like a new database it offers a generated passphrase first: a
   * master password is typed from memory, and the one a person invents for
   * themselves is the weakest part of the whole design. Typing your own is one
   * click away.
   */
  function openMasterKeyDialog() {
    const info = IV.state.info;
    const keyPath = h('input', { type: 'text', readOnly: true, value: info.keyFilePath || '', placeholder: 'None' });

    let mode = 'generated';
    let generated = '';

    const previewText = h('div', { class: 'gen-preview-text' });
    const copiedNote = h('p', { class: 'hint' });
    const preview = h(
      'div',
      { class: 'gen-preview' },
      previewText,
      h(
        'div',
        { class: 'gen-preview-actions' },
        h('button', { class: 'icon-btn refresh', title: 'Generate another', onClick: () => regenerate() }),
        h('button', {
          class: 'icon-btn copy',
          title: 'Copy to the clipboard',
          onClick: async () => {
            if (!generated) return;
            await IV.api.copy(generated);
            copiedNote.textContent = 'Copied. Paste it somewhere safe before you finish.';
          }
        })
      )
    );
    const meter = h('div', { class: 'gen-meter' });

    const pass1 = h('input', { type: 'password', autocomplete: 'new-password' });
    const pass2 = h('input', { type: 'password', autocomplete: 'new-password' });
    const manualMeter = h('div');

    pass1.addEventListener('input', async () => {
      const estimate = await IV.api.strength(pass1.value);
      clear(manualMeter);
      if (pass1.value) manualMeter.append(strengthMeter(estimate));
    });

    async function regenerate() {
      try {
        const result = await IV.api.generate({
          ...(IV.state.prefs.generator || {}),
          algorithm: 'diceware',
          wordCount: 6,
          casing: 'title',
          separator: '-'
        });
        generated = result.password;
        IV.generator.colorize(generated, previewText);
        clear(meter).append(strengthMeter(result.strength));
      } catch (err) {
        generated = '';
        clear(previewText).append(h('span', { class: 'gen-error', text: err.message }));
      }
    }

    const generatedPanel = h(
      'div',
      null,
      IV.glossary.label('Your new master password', 'diceware'),
      preview,
      meter,
      copiedNote,
      h(
        'div',
        { class: 'row-gap' },
        h('button', {
          class: 'btn ghost small',
          text: 'Other options...',
          onClick: () =>
            IV.generator.openGenerator({
              title: 'Choose a master password',
              mode: 'diceware',
              onUse: async (value) => {
                generated = value;
                IV.generator.colorize(generated, previewText);
                clear(meter).append(strengthMeter(await IV.api.strength(value)));
              }
            })
        }),
        h('button', { class: 'btn ghost small', text: 'Type my own', onClick: () => setMode('manual') })
      ),
      h('p', {
        class: 'error-line',
        text: 'Write this down before you continue. There is no reset, no recovery, and no back door. Lose it and the database is gone.'
      })
    );

    const manualPanel = h(
      'div',
      { hidden: true },
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'New master password' }), pass1, manualMeter),
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Repeat password' }), pass2),
      h('button', { class: 'btn ghost small', text: 'Generate one for me instead', onClick: () => setMode('generated') })
    );

    function setMode(next) {
      mode = next;
      generatedPanel.hidden = next !== 'generated';
      manualPanel.hidden = next !== 'manual';
      if (next === 'manual') setTimeout(() => pass1.focus(), 20);
    }

    async function submit() {
      const password = mode === 'generated' ? generated : pass1.value;
      if (mode === 'manual' && pass1.value !== pass2.value) {
        toast('The two passwords do not match', 'error');
        return;
      }
      if (!password && !keyPath.value) {
        toast('Set a password, a key file, or both', 'error');
        return;
      }
      if (mode === 'generated') {
        const saved = await IV.api.confirm({
          title: 'Have you saved it?',
          message: 'Have you written down or saved the new master password?',
          detail: 'This is the only time it is shown. Nobody can recover it for you.',
          confirmLabel: 'Yes, I saved it'
        });
        if (!saved) return;
      }
      const confirmed = await IV.api.confirm({
        title: 'Change master key',
        message: 'Change the master key for this database?',
        detail: 'The file is rewritten immediately. Anything that unlocks it today will stop working.',
        confirmLabel: 'Change key',
        destructive: true
      });
      if (!confirmed) return;
      try {
        await IV.api.changeCredentials({ password, keyFilePath: keyPath.value || null });
        await IV.api.setQuickUnlock({ filePath: info.filePath, enabled: false });
        handle.close();
        await IV.app.refresh();
        toast('Master key changed', 'good');
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    const handle = modal({
      title: 'Change master key',
      wide: true,
      body: h(
        'div',
        null,
        generatedPanel,
        manualPanel,
        h(
          'div',
          { class: 'field' },
          h('span', { class: 'field-label', text: 'Key file' }),
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
        ),
        h('p', { class: 'hint', text: 'Any saved quick unlock for this database is discarded.' })
      ),
      footer: [
        h('button', { class: 'btn ghost', text: 'Cancel', onClick: () => handle.close() }),
        h('button', { class: 'btn primary', text: 'Change key', onClick: submit })
      ]
    });

    setMode('generated');
    regenerate();
    return handle;
  }

  IV.editor = { openEntryEditor, openGroupEditor, openMasterKeyDialog, groupOptions };
})(window.IV);
