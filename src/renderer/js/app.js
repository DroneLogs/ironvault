/* Application controller: screens, navigation, and everything that ties the
   panes together. */
window.IV = window.IV || {};

(function (IV) {
  'use strict';

  const { h, $, $$, clear, toast, modal, avatar } = IV.dom;

  const state = {
    app: { version: '', electron: '' },
    prefs: {},
    wordLists: [],
    update: null,
    quickUnlockAvailable: false,
    info: null,
    tree: null,
    selection: { type: 'smart', key: 'all', label: 'All entries' },
    entries: [],
    entryId: null,
    entry: null,
    query: '',
    sort: 'title',
    collapsed: new Set(),
    hasQuickUnlock: false,
    pendingDb: null
  };
  IV.state = state;

  const SMART_LISTS = [
    { key: 'all', label: 'All entries', glyph: '◈' },
    { key: 'favorites', label: 'Favorites', glyph: '★' },
    { key: 'recent', label: 'Recently changed', glyph: '↺' },
    { key: 'totp', label: 'One time codes', glyph: '⏱' },
    { key: 'expired', label: 'Expired', glyph: '⚠' },
    { key: 'recycle', label: 'Recycle bin', glyph: '⌧' }
  ];

  /* -------------------------------------------------------------- boot */

  async function boot() {
    const info = await IV.api.appInfo();
    state.app = info;
    state.prefs = info.prefs;
    state.wordLists = info.wordLists || [];
    state.itemTypes = info.itemTypes || [];
    state.itemTypeField = info.itemTypeField || 'PROPOLIS_TYPE';
    state.productName = info.productName || 'Propolis';
    state.iconKey = info.iconKey || 'blue';
    state.systemDark = info.systemDark !== false;
    state.tagline = info.tagline || '';
    state.quickUnlockAvailable = info.quickUnlockAvailable;
    applyTheme();
    applyBrand();
    nameStaticIconButtons();
    wireGlobalEvents();
    await showLockScreen();
    if (info.openWith) await openPath(info.openWith);
  }

  /** Show the unlock panel for a path, whether or not we have seen it before. */
  async function openPath(filePath) {
    const known = (await IV.api.listDatabases()).find(
      (d) => d.path.toLowerCase() === filePath.toLowerCase()
    );
    showUnlockPanel(
      known || {
        path: filePath,
        name: filePath.split(/[\/]/).pop().replace(/\.kdbx$/i, ''),
        keyFilePath: null,
        hasQuickUnlock: false
      }
    );
  }

  /** Title bar name, lock screen name and logo, all from the chosen theme. */
  function applyBrand() {
    const name = state.productName || 'Propolis';
    const icon = state.iconKey || 'blue';

    for (const node of $$('.brand-name, .lock-title')) node.textContent = name;
    for (const img of $$('.brand-mark, .lock-logo')) img.src = 'icons/app-' + icon + '.png';
    const tagline = $('.lock-tagline');
    if (tagline && state.tagline) tagline.textContent = state.tagline;
    document.title = name;
  }

  /**
   * Buttons written directly into index.html never pass through the helper that
   * borrows a tooltip for the accessible name, so they are swept once at boot.
   */
  function nameStaticIconButtons() {
    for (const button of $$('button')) {
      if (button.getAttribute('aria-label')) continue;
      if (button.textContent.trim()) continue;
      const title = button.getAttribute('title');
      if (title) button.setAttribute('aria-label', title);
    }
  }

  /**
   * Windows draws the minimise, maximise and close buttons itself, so they do
   * not follow a stylesheet. Read back what the title bar actually resolved to
   * and hand those two colours to the main process. Reading them rather than
   * listing them here means every palette, light and dark, and high contrast on
   * top, all come out right without a lookup table to keep in step.
   */
  function hex(colour) {
    const parts = String(colour).match(/\d+/g);
    if (!parts || parts.length < 3) return null;
    return '#' + parts.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('');
  }

  function reportTitleBarColors() {
    const bar = $('#titlebar');
    if (!bar) return;
    const barStyle = getComputedStyle(bar);
    const color = hex(barStyle.backgroundColor);
    const symbolColor = hex(getComputedStyle(document.body).color);
    if (!color || !symbolColor) return;
    IV.api.titleBarColors({ color, symbolColor }).catch(() => {});
  }

  function applyTheme() {
    const body = document.body;
    const prefs = state.prefs;
    const theme = prefs.theme || 'blue-cb';

    for (const key of ['blue', 'blue-cb', 'amber', 'amber-cb']) {
      body.classList.toggle('scheme-' + key, theme === key);
    }
    const dark =
      prefs.appearance === 'dark' ||
      (prefs.appearance !== 'light' && state.systemDark !== false);
    body.classList.toggle('theme-light', !dark);
    body.classList.toggle('font-dyslexic', prefs.uiFont === 'dyslexic');
    body.classList.toggle('font-hyperlegible', prefs.uiFont === 'hyperlegible');
    body.classList.toggle('large-text', Number(prefs.zoom || 1) >= 1.25);
    body.classList.toggle('reduce-motion', Boolean(prefs.reduceMotion));
    body.classList.toggle('strong-focus', Boolean(prefs.strongFocus));
    body.classList.toggle('big-targets', Boolean(prefs.bigTargets));
    body.classList.toggle('high-contrast', Boolean(prefs.highContrast));

    // After the classes, so the computed colours are the ones now in force.
    reportTitleBarColors();
  }

  /* ------------------------------------------------------- lock screen */

  async function showLockScreen() {
    IV.detail.stopTimers();
    $('#screen-main').hidden = true;
    $('#screen-lock').hidden = false;
    $('#unlock-panel').hidden = true;
    $('#db-picker').hidden = false;
    $('#titlebar-db').textContent = '';
    $('#titlebar-dirty').hidden = true;
    state.info = null;
    state.tree = null;
    state.entry = null;
    state.entryId = null;
    await renderDatabaseList();
  }

  async function renderDatabaseList() {
    const databases = await IV.api.listDatabases();
    const list = clear($('#db-list'));
    $('#db-empty').hidden = databases.length > 0;

    for (const db of databases) {
      const item = h(
        'li',
        {
          class: 'db-item' + (db.exists ? '' : ' missing'),
          role: 'button',
          'aria-label': db.name + (db.exists ? '' : ', file not found') + '. ' + db.path,
          onActivate: () => (db.exists ? showUnlockPanel(db) : offerForget(db))
        },
        h('div', { class: 'db-icon', text: IV.dom.initials(db.name) }),
        h(
          'div',
          { class: 'db-meta' },
          h('div', { class: 'db-name', text: db.name }),
          h('div', {
            class: 'db-sub',
            text: db.exists ? db.path : 'File not found · ' + db.path
          })
        ),
        db.hasQuickUnlock ? h('span', { class: 'db-badge', text: 'quick unlock' }) : null,
        h('button', {
          class: 'icon-btn close',
          title: 'Remove from this list',
          onClick: async (e) => {
            e.stopPropagation();
            await IV.api.forgetDatabase(db.path);
            await renderDatabaseList();
          }
        })
      );
      list.append(item);
    }
  }

  async function offerForget(db) {
    const ok = await IV.api.confirm({
      title: 'File not found',
      message: 'This database is no longer at ' + db.path,
      detail: 'Remove it from the list?',
      confirmLabel: 'Remove'
    });
    if (ok) {
      await IV.api.forgetDatabase(db.path);
      await renderDatabaseList();
    }
  }

  function showUnlockPanel(db) {
    state.pendingDb = db;
    $('#db-picker').hidden = true;
    $('#unlock-panel').hidden = false;
    $('#unlock-title').textContent = db.name;
    $('#unlock-path').textContent = db.path;
    $('#unlock-password').value = '';
    $('#unlock-keyfile').value = db.keyFilePath || '';
    $('#unlock-error').hidden = true;
    $('#unlock-remember').checked = false;
    $('#unlock-remember').parentElement.hidden = !state.quickUnlockAvailable;
    $('#btn-quick-unlock').hidden = !db.hasQuickUnlock;
    $('#btn-hello-unlock').hidden = !db.hasHello;
    $('#unlock-pin-row').hidden = !db.hasPin;
    $('#unlock-pin').value = '';
    $('#unlock-readonly').checked = false;
    setTimeout(() => $('#unlock-password').focus(), 30);
  }

  async function doUnlock(useQuickUnlock) {
    const db = state.pendingDb;
    if (!db) return;
    const errorLine = $('#unlock-error');
    errorLine.hidden = true;
    const button = useQuickUnlock ? $('#btn-quick-unlock') : $('#btn-unlock');
    button.disabled = true;
    button.textContent = 'Unlocking...';

    try {
      const info = useQuickUnlock
        ? await IV.api.quickUnlock(db.path)
        : await IV.api.openDatabase({
            filePath: db.path,
            password: $('#unlock-password').value,
            keyFilePath: $('#unlock-keyfile').value || null,
            rememberQuickUnlock: $('#unlock-remember').checked,
            readOnly: $('#unlock-readonly').checked
          });
      state.hasQuickUnlock = useQuickUnlock || $('#unlock-remember').checked || db.hasQuickUnlock;
      $('#unlock-password').value = '';
      await enterMainScreen(info);
    } catch (err) {
      errorLine.textContent = err.message;
      errorLine.hidden = false;
      $('#unlock-password').select();
    } finally {
      button.disabled = false;
      button.textContent = useQuickUnlock ? 'Quick unlock' : 'Unlock';
    }
  }

  /* ------------------------------------------------------ new database */


  /**
   * New database. A memorable passphrase is generated up front, the way
   * Strongbox does it, because a master password people choose for themselves
   * is the weakest link in the whole design. Typing your own is one click away.
   */
  async function newDatabase() {
    const nameInput = h('input', { type: 'text', value: 'My Passwords' });
    const formatSelect = h(
      'select',
      null,
      h('option', { value: '4', text: 'KDBX 4 with Argon2 (recommended)' }),
      h('option', { value: '3', text: 'KDBX 3.1 with AES-KDF (older readers)' })
    );
    const keyPath = h('input', { type: 'text', readOnly: true, placeholder: 'None' });

    let mode = 'generated';
    let generated = '';

    const previewText = h('div', { class: 'gen-preview-text' });
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
            await IV.api.copy(generated);
            copiedNote.textContent = 'Copied. Paste it somewhere safe before you finish.';
          }
        })
      )
    );
    const meter = h('div', { class: 'gen-meter' });
    const copiedNote = h('p', { class: 'hint' });

    const pass1 = h('input', { type: 'password', autocomplete: 'new-password' });
    const pass2 = h('input', { type: 'password', autocomplete: 'new-password' });
    const manualMeter = h('div');

    pass1.addEventListener('input', async () => {
      const estimate = await IV.api.strength(pass1.value);
      clear(manualMeter);
      if (pass1.value) manualMeter.append(IV.dom.strengthMeter(estimate));
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
        clear(meter).append(IV.dom.strengthMeter(result.strength));
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
                clear(meter).append(IV.dom.strengthMeter(await IV.api.strength(value)));
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
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Master password' }), pass1, manualMeter),
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
        toast('Set a master password, a key file, or both', 'error');
        return;
      }
      if (mode === 'generated') {
        const ok = await IV.api.confirm({
          title: 'Have you saved it?',
          message: 'Have you written down or saved the master password?',
          detail: 'This is the only time it is shown. Nobody can recover it for you.',
          confirmLabel: 'Yes, I saved it'
        });
        if (!ok) return;
      }

      const filePath = await IV.api.chooseNew(nameInput.value.trim() || 'My Passwords');
      if (!filePath) return;
      try {
        const info = await IV.api.createDatabase({
          filePath,
          password,
          keyFilePath: keyPath.value || null,
          name: nameInput.value.trim() || 'My Passwords',
          format: Number(formatSelect.value)
        });
        handle.close();
        state.hasQuickUnlock = false;
        await enterMainScreen(info);
        toast('Database created', 'good');
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    const handle = modal({
      title: 'New database',
      wide: true,
      body: h(
        'div',
        null,
        h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Name' }), nameInput),
        generatedPanel,
        manualPanel,
        h(
          'div',
          { class: 'field' },
          IV.glossary.label('Key file (optional)', 'keyfile'),
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
        h('label', { class: 'field' }, IV.glossary.label('Format', 'kdf'), formatSelect)
      ),
      footer: [
        h('button', { class: 'btn ghost', text: 'Cancel', onClick: () => handle.close() }),
        h('button', { class: 'btn primary', text: 'Choose location and create', onClick: submit })
      ]
    });

    await regenerate();
  }

  async function openExisting() {
    const filePath = await IV.api.chooseOpen();
    if (!filePath) return;
    const known = (await IV.api.listDatabases()).find((d) => d.path === filePath);
    showUnlockPanel(
      known || { path: filePath, name: filePath.split(/[\\/]/).pop().replace(/\.kdbx$/i, ''), keyFilePath: null, hasQuickUnlock: false }
    );
  }

  /* ------------------------------------------------------- main screen */

  async function enterMainScreen(info) {
    state.info = info;
    $('#screen-lock').hidden = true;
    $('#screen-main').hidden = false;
    $('#titlebar-db').textContent = info.name;
    state.selection = { type: 'smart', key: 'all', label: 'All entries' };
    state.query = '';
    $('#search-input').value = '';
    await refresh();
    checkMasterKeyAge();
  }

  /** Nudges when the master password has not changed in a long time. */
  async function checkMasterKeyAge() {
    const limit = Number(state.prefs.masterPasswordReminderDays || 0);
    if (!limit) return;
    try {
      const age = await IV.api.masterKeyAge();
      if (!age.known || age.days < limit) return;
      const ok = await IV.api.confirm({
        title: 'Master password reminder',
        message: 'Your master password was last changed ' + age.days + ' days ago.',
        detail: 'Changing it now is optional. You can turn this reminder off in Settings.',
        confirmLabel: 'Change it now'
      });
      if (ok) IV.editor.openMasterKeyDialog();
    } catch {
      /* a reminder is never worth an error */
    }
  }

  async function refresh({ selectEntryId } = {}) {
    if (!state.info) return;
    state.info = await IV.api.info();
    if (!state.info.open) {
      await showLockScreen();
      return;
    }
    $('#titlebar-dirty').hidden = !state.info.dirty;
    $('#titlebar-readonly').hidden = !state.info.readOnly;
    state.tree = await IV.api.tree();
    renderSidebar();
    if (selectEntryId !== undefined) state.entryId = selectEntryId;
    await loadEntries();
  }

  function renderSidebar() {
    const smart = clear($('#smart-list'));
    for (const item of SMART_LISTS) {
      if (item.key === 'recycle' && !state.tree.counts.recycleBin) continue;
      const active = state.selection.type === 'smart' && state.selection.key === item.key;
      let count = null;
      if (item.key === 'all') count = state.tree.counts.all;
      if (item.key === 'recycle') count = state.tree.counts.recycleBin;
      IV.dom.add(smart,
        h(
          'li',
          {
            class: 'nav-item' + (active ? ' active' : ''),
            role: 'button',
            'aria-current': active ? 'true' : null,
            'aria-label': item.label + (count != null ? ', ' + count + ' entries' : ''),
            onActivate: () => select({ type: 'smart', key: item.key, label: item.label })
          },
          h('span', { class: 'nav-glyph', text: item.glyph }),
          h('span', { class: 'nav-label', text: item.label }),
          count != null ? h('span', { class: 'nav-count', text: String(count) }) : null
        )
      );
    }

    const tree = clear($('#group-tree'));
    for (const group of state.tree.root.groups) {
      if (group.isRecycleBin) continue;
      renderGroupNode(group, tree, 0);
    }
  }

  function renderGroupNode(group, container, depth) {
    const active = state.selection.type === 'group' && state.selection.key === group.id;
    const hasChildren = group.groups.some((g) => !g.isRecycleBin);
    const isCollapsed = state.collapsed.has(group.id);

    const twisty = h('span', {
      class: 'nav-twisty' + (hasChildren ? '' : ' leaf'),
      text: isCollapsed ? '▸' : '▾',
      onClick: (e) => {
        e.stopPropagation();
        if (isCollapsed) state.collapsed.delete(group.id);
        else state.collapsed.add(group.id);
        renderSidebar();
      }
    });

    const node = h(
      'li',
      {
        class: 'nav-item' + (active ? ' active' : ''),
        role: 'treeitem',
        'aria-level': String(depth + 1),
        'aria-selected': active ? 'true' : 'false',
        'aria-expanded': hasChildren ? String(!isCollapsed) : null,
        'aria-label': group.name + ', ' + group.totalEntryCount + ' entries',
        onActivate: () => select({ type: 'group', key: group.id, label: group.name }),
        onKeydown: (e) => {
          // Arrow keys are what a tree is expected to answer to.
          if (e.key === 'ArrowRight' && hasChildren && isCollapsed) {
            e.preventDefault();
            state.collapsed.delete(group.id);
            renderSidebar();
          } else if (e.key === 'ArrowLeft' && hasChildren && !isCollapsed) {
            e.preventDefault();
            state.collapsed.add(group.id);
            renderSidebar();
          } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const items = $$('#group-tree .nav-item');
            const index = items.indexOf(e.currentTarget);
            const next = items[index + (e.key === 'ArrowDown' ? 1 : -1)];
            if (next) next.focus();
          }
        },
        onContextmenu: (e) => {
          e.preventDefault();
          openGroupMenu(group);
        }
      },
      twisty,
      h('span', { class: 'nav-label', text: group.name }),
      group.totalEntryCount ? h('span', { class: 'nav-count', text: String(group.totalEntryCount) }) : null
    );
    node.style.setProperty('padding-left', 9 + depth * 12 + 'px');
    container.append(node);

    if (hasChildren && !isCollapsed) {
      for (const child of group.groups) {
        if (child.isRecycleBin) continue;
        renderGroupNode(child, container, depth + 1);
      }
    }
  }

  function openGroupMenu(group) {
    const items = [
      { label: 'New entry here', run: () => IV.editor.openEntryEditor(null, group.id) },
      { label: 'New sub group', run: () => IV.editor.openGroupEditor(null, group.id) },
      { label: 'Rename', run: () => IV.editor.openGroupEditor(group) },
      {
        label: 'Delete group',
        danger: true,
        run: async () => {
          const ok = await IV.api.confirm({
            title: 'Delete group',
            message: 'Delete "' + group.name + '" and everything inside it?',
            detail: group.totalEntryCount + ' entries would go to the recycle bin.',
            confirmLabel: 'Delete',
            destructive: true
          });
          if (!ok) return;
          await IV.api.deleteGroup(group.id, false);
          state.selection = { type: 'smart', key: 'all', label: 'All entries' };
          await refresh({ selectEntryId: null });
          await autoSave();
          toast('Group deleted');
        }
      }
    ];

    const menu = h(
      'div',
      null,
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
    const handle = modal({ title: group.name, body: menu });
  }

  async function select(selection) {
    state.selection = selection;
    state.query = '';
    $('#search-input').value = '';
    state.entryId = null;
    renderSidebar();
    await loadEntries();
  }

  async function loadEntries() {
    let entries;
    if (state.query) {
      entries = await IV.api.search(state.query, state.selection.key === 'recycle');
      $('#list-title').textContent = 'Search results';
    } else if (state.selection.type === 'group') {
      entries = await IV.api.listEntries({ groupId: state.selection.key, includeSubgroups: true });
      $('#list-title').textContent = state.selection.label;
    } else {
      entries = await IV.api.listEntries({ scope: state.selection.key });
      $('#list-title').textContent = state.selection.label;
    }

    state.entries = sortEntries(entries);
    renderEntryList();

    const countText =
      state.entries.length +
      (state.entries.length === 1 ? ' entry' : ' entries') +
      ' in ' +
      $('#list-title').textContent;
    const countNode = $('#list-count');
    if (countNode) countNode.textContent = countText;
    IV.dom.announce(countText);

    if (state.entryId && !state.entries.some((e) => e.id === state.entryId)) state.entryId = null;
    if (state.entryId) await showEntry(state.entryId, true);
    else IV.detail.render(null);
  }

  function sortEntries(entries) {
    const key = state.sort;
    const copy = entries.slice();
    copy.sort((a, b) => {
      if (key === 'modified') return (b.modified || 0) - (a.modified || 0);
      if (key === 'created') return (b.created || 0) - (a.created || 0);
      if (key === 'username') return (a.username || '').localeCompare(b.username || '');
      return (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' });
    });
    return copy;
  }

  function renderEntryList() {
    const list = clear($('#entry-list'));
    $('#list-empty').hidden = state.entries.length > 0;
    $('#list-empty').textContent = state.query ? 'No matches.' : 'Nothing here yet.';

    for (const entry of state.entries) {
      const actions = h(
        'div',
        { class: 'entry-actions' },
        h('button', {
          class: 'icon-btn copy',
          title: 'Copy password',
          onClick: async (e) => {
            e.stopPropagation();
            try {
              await IV.api.copyField(entry.id, 'Password');
              toast('Password copied');
            } catch (err) {
              toast(err.message, 'error');
            }
          }
        })
      );
      if (entry.username) {
        actions.prepend(
          h('button', {
            class: 'icon-btn edit',
            title: 'Copy username',
            onClick: async (e) => {
              e.stopPropagation();
              await IV.api.copyField(entry.id, 'UserName');
              toast('Username copied');
            }
          })
        );
      }

      const flags = h('div', { class: 'entry-flags' });
      if (entry.expired) flags.append(h('span', { class: 'pill-expired', text: 'expired' }));
      if (entry.hasTotp) flags.append(h('span', { text: '⏱' }));
      if (entry.attachmentCount) flags.append(h('span', { text: '\u{1F4CE}' }));
      if ((entry.tags || []).some((t) => /^favou?rite$/i.test(t))) flags.append(h('span', { text: '★' }));

      const spoken = [
        entry.title || 'no title',
        entry.username ? 'user ' + entry.username : '',
        entry.groupName ? 'in ' + entry.groupName : '',
        entry.expired ? 'expired' : '',
        entry.hasTotp ? 'has a one time code' : '',
        entry.attachmentCount ? entry.attachmentCount + ' attachments' : ''
      ]
        .filter(Boolean)
        .join(', ');

      list.append(
        h(
          'li',
          {
            class: 'entry-row' + (entry.id === state.entryId ? ' active' : ''),
            role: 'option',
            'aria-selected': entry.id === state.entryId ? 'true' : 'false',
            'aria-label': spoken,
            onActivate: () => showEntry(entry.id),
            onDblclick: async () => {
              const full = await IV.api.entry(entry.id);
              IV.editor.openEntryEditor(full);
            }
          },
          avatar(entry),
          h(
            'div',
            { class: 'entry-main' },
            h('div', { class: 'entry-title', text: entry.title || '(no title)' }),
            h('div', {
              class: 'entry-sub',
              text: entry.username || entry.url || entry.groupName || ''
            })
          ),
          flags,
          actions
        )
      );
    }
  }

  async function showEntry(id, keepList) {
    try {
      const entry = await IV.api.entry(id);
      state.entryId = id;
      state.entry = entry;
      if (!keepList) {
        // Selecting from the audit or a search result may point at an entry the
        // current list does not contain; widen to all entries so it shows up.
        if (!state.entries.some((e) => e.id === id)) {
          state.selection = { type: 'smart', key: 'all', label: 'All entries' };
          state.query = '';
          $('#search-input').value = '';
          renderSidebar();
          state.entries = sortEntries(await IV.api.listEntries({ scope: 'all' }));
          $('#list-title').textContent = 'All entries';
        }
      }
      renderEntryList();
      IV.detail.render(entry);
      const active = $('.entry-row.active');
      if (active) active.scrollIntoView({ block: 'nearest' });
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /* --------------------------------------------------------- autosave */

  let saveTimer = null;
  async function autoSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        state.info = await IV.api.save();
        $('#titlebar-dirty').hidden = true;
      } catch (err) {
        toast('Could not save: ' + err.message, 'error');
      }
    }, 300);
  }

  async function saveNow() {
    try {
      state.info = await IV.api.save();
      $('#titlebar-dirty').hidden = true;
      toast('Saved', 'good');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /* ------------------------------------------------------ global wiring */

  function wireGlobalEvents() {
    // Only matters while the appearance is left to the device.
    IV.api.on('system-theme', (state2) => {
      state.systemDark = Boolean(state2 && state2.dark);
      if (state.prefs.appearance !== 'light' && state.prefs.appearance !== 'dark') applyTheme();
    });

    $('#btn-open-db').addEventListener('click', openExisting);
    $('#btn-new-db').addEventListener('click', newDatabase);
    $('#btn-unlock-back').addEventListener('click', () => {
      $('#unlock-panel').hidden = true;
      $('#db-picker').hidden = false;
      renderDatabaseList();
    });
    $('#unlock-form').addEventListener('submit', (e) => {
      e.preventDefault();
      doUnlock(false);
    });
    $('#btn-quick-unlock').addEventListener('click', () => doUnlock(true));

    $('#btn-hello-unlock').addEventListener('click', async () => {
      const db = state.pendingDb;
      if (!db) return;
      const button = $('#btn-hello-unlock');
      const errorLine = $('#unlock-error');
      errorLine.hidden = true;
      button.disabled = true;
      button.textContent = 'Waiting for Hello...';
      try {
        state.hasQuickUnlock = true;
        await enterMainScreen(await IV.api.helloUnlock(db.path));
      } catch (err) {
        errorLine.textContent = err.message;
        errorLine.hidden = false;
      } finally {
        button.disabled = false;
        button.textContent = 'Windows Hello';
      }
    });

    const pinUnlock = async () => {
      const db = state.pendingDb;
      if (!db) return;
      const errorLine = $('#unlock-error');
      errorLine.hidden = true;
      const button = $('#btn-pin-unlock');
      button.disabled = true;
      try {
        const info = await IV.api.pinUnlock(db.path, $('#unlock-pin').value);
        $('#unlock-pin').value = '';
        await enterMainScreen(info);
        if (info.decoy) toast('Opened');
      } catch (err) {
        if (err.code === 'WIPED') {
          errorLine.textContent = 'Wrong PIN';
        } else {
          errorLine.textContent = err.message;
        }
        errorLine.hidden = false;
        $('#unlock-pin').select();
      } finally {
        button.disabled = false;
      }
    };
    $('#btn-pin-unlock').addEventListener('click', pinUnlock);
    $('#unlock-pin').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        pinUnlock();
      }
    });
    $('#btn-pick-keyfile').addEventListener('click', async () => {
      const picked = await IV.api.chooseKeyFile();
      if (picked) $('#unlock-keyfile').value = picked;
    });
    $('#btn-clear-keyfile').addEventListener('click', () => ($('#unlock-keyfile').value = ''));

    const keyfileLabel = $('#unlock-keyfile-label');
    if (keyfileLabel) keyfileLabel.append(IV.glossary.badge('keyfile'));

    const readonlyLabel = $('#unlock-readonly-label');
    if (readonlyLabel) readonlyLabel.append(IV.glossary.badge('readonly'));

    for (const button of $$('[data-reveal]')) {
      button.addEventListener('click', () => {
        const input = document.getElementById(button.dataset.reveal);
        const showing = input.type === 'text';
        input.type = showing ? 'password' : 'text';
        button.classList.toggle('on', !showing);
        IV.dom.reportSecrets();
      });
    }

    let searchTimer = null;
    $('#search-input').addEventListener('input', (e) => {
      state.query = e.target.value.trim();
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(loadEntries, 120);
    });
    $('#search-input').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.target.value = '';
        state.query = '';
        loadEntries();
      }
    });

    $('#sort-select').addEventListener('change', (e) => {
      state.sort = e.target.value;
      state.entries = sortEntries(state.entries);
      renderEntryList();
    });

    $('#btn-add-entry').addEventListener('click', () =>
      IV.editor.openEntryEditor(null, state.selection.type === 'group' ? state.selection.key : null)
    );
    $('#btn-add-group').addEventListener('click', () =>
      IV.editor.openGroupEditor(null, state.selection.type === 'group' ? state.selection.key : null)
    );
    $('#btn-generator').addEventListener('click', () => IV.generator.openGenerator({}));
    $('#btn-audit').addEventListener('click', () => IV.audit.openAudit());
    $('#btn-settings').addEventListener('click', () => IV.settings.openSettings());
    $('#btn-lock').addEventListener('click', () => IV.api.lock());

    IV.api.on('vault:locked', async (payload) => {
      IV.detail.stopTimers();
      await showLockScreen();
      if (payload && payload.reason && payload.reason !== 'manual') {
        toast('Locked (' + payload.reason + ')');
      }
    });

    IV.api.on('clipboard:cleared', () => toast('Clipboard cleared'));

    IV.api.on('update-state', (update) => {
      state.update = update;
      if (IV.settings.onUpdateState) IV.settings.onUpdateState(update);
      // A check that ran on its own opens the dialog rather than showing a
      // toast. A toast disappears after a few seconds, so an update found while
      // the user was making coffee was never seen at all.
      if (update.status === 'available' && update.automatic) {
        IV.settings.promptForUpdate(update);
      }
    });

    IV.api.on('open-file', async ({ filePath }) => {
      if (state.info) {
        const ok = await IV.api.confirm({
          title: 'Open another database',
          message: 'Lock the current database and open ' + filePath + '?',
          confirmLabel: 'Open'
        });
        if (!ok) return;
        await IV.api.lock();
      }
      await openPath(filePath);
    });

    IV.api.on('menu', handleMenu);

    IV.api.on('autotype-result', (result) => {
      if (result.ok) toast('Typed ' + result.title + ' into ' + result.window);
      else toast(result.error || 'Auto-type failed', 'error');
    });

    IV.api.on('url-search', ({ query }) => {
      if (!state.info) return;
      $('#search-input').value = query;
      state.query = query;
      loadEntries();
    });

    IV.api.on('ssh-agent', (event) => {
      if (event.type === 'signed') toast('SSH key used: ' + event.comment);
      else if (event.type === 'error') toast('SSH agent: ' + event.message, 'error');
    });

    document.addEventListener('keydown', handleKeydown);
  }

  async function handleMenu(action) {
    const top = IV.dom.topModal();
    switch (action) {
      case 'database:new':
        if (!state.info) newDatabase();
        break;
      case 'database:open':
        if (!state.info) openExisting();
        break;
      case 'database:save':
        if (state.info) saveNow();
        break;
      case 'database:lock':
        if (state.info) IV.api.lock();
        break;
      case 'app:settings':
        IV.settings.openSettings();
        break;
      case 'app:search':
        if (state.info) $('#search-input').focus();
        break;
      case 'app:generator':
        IV.generator.openGenerator({});
        break;
      case 'app:audit':
        if (state.info) IV.audit.openAudit();
        break;
      case 'app:shortcuts':
        IV.settings.openShortcuts();
        break;
      case 'app:updates':
        IV.settings.openUpdates();
        break;
      case 'tools:compare':
        if (state.info) IV.tools.openCompare();
        break;
      case 'tools:sync':
        if (state.info) IV.tools.syncNow();
        break;
      case 'tools:import':
      case 'tools:export':
        if (state.info) IV.tools.openTransfer();
        break;
      case 'tools:pwned':
        if (state.info) IV.tools.openPwned();
        break;
      case 'tools:similar':
        if (state.info) IV.tools.openSimilar();
        break;
      case 'tools:favicons':
        if (state.info) IV.tools.openFavicons();
        break;
      case 'tools:backups':
        if (state.info) IV.tools.openBackups();
        break;
      case 'tools:security':
        if (state.info) IV.tools.openSecurity();
        break;
      case 'tools:remote':
        if (state.info) IV.tools.openRemote();
        break;
      case 'tools:travel':
        if (state.info) IV.tools.openTravel();
        break;
      case 'tools:ssh':
        IV.tools.openSsh();
        break;
      case 'app:about':
        IV.settings.openAbout();
        break;
      case 'entry:new':
        if (state.info && !top) IV.editor.openEntryEditor(null, state.selection.type === 'group' ? state.selection.key : null);
        break;
      case 'group:new':
        if (state.info && !top) IV.editor.openGroupEditor(null, state.selection.type === 'group' ? state.selection.key : null);
        break;
      case 'entry:copyUsername':
        await copyFromSelection('UserName', 'Username copied');
        break;
      case 'entry:copyPassword':
        await copyFromSelection('Password', 'Password copied');
        break;
      case 'entry:copyTotp':
        if (state.entryId) {
          try {
            await IV.api.copyTotp(state.entryId);
            toast('One time code copied');
          } catch (err) {
            toast(err.message, 'error');
          }
        }
        break;
      case 'entry:openUrl':
        if (state.entry && state.entry.url) IV.api.openUrl(state.entry.url).catch((err) => toast(err.message, 'error'));
        break;
      default:
        break;
    }
  }

  async function copyFromSelection(fieldName, message) {
    if (!state.entryId) return;
    try {
      await IV.api.copyField(state.entryId, fieldName);
      toast(message);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function handleKeydown(e) {
    if (e.key === 'Escape') {
      const top = IV.dom.topModal();
      if (top) {
        top.close();
        e.preventDefault();
      }
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e' && !IV.dom.topModal()) {
      if (state.entry) {
        e.preventDefault();
        IV.editor.openEntryEditor(state.entry);
      }
      return;
    }

    if (!state.info || IV.dom.topModal()) return;
    const inField = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);

    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !inField) {
      e.preventDefault();
      const index = state.entries.findIndex((x) => x.id === state.entryId);
      const next = e.key === 'ArrowDown' ? index + 1 : index - 1;
      if (next >= 0 && next < state.entries.length) showEntry(state.entries[next].id, true);
      else if (index === -1 && state.entries.length) showEntry(state.entries[0].id, true);
    }

    if (e.key === 'Delete' && !inField && state.entry) {
      e.preventDefault();
      (async () => {
        const ok = await IV.api.confirm({
          title: 'Delete entry',
          message: 'Move "' + (state.entry.title || 'this entry') + '" to the recycle bin?',
          confirmLabel: 'Delete',
          destructive: true
        });
        if (!ok) return;
        await IV.api.deleteEntry(state.entry.id, state.entry.inRecycleBin);
        await refresh({ selectEntryId: null });
        await autoSave();
      })();
    }
  }

  IV.app = { boot, refresh, showEntry, autoSave, saveNow, applyTheme, applyBrand, select };

  document.addEventListener('DOMContentLoaded', () => {
    boot().catch((err) => {
      document.body.append(h('pre', { text: 'Startup failed: ' + err.message }));
    });
  });
})(window.IV);
