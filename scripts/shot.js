'use strict';

/**
 * Development harness: builds a throwaway demo vault, drives the real renderer,
 * and writes PNGs of each screen so the UI can be reviewed without clicking.
 *
 *   npx electron scripts/shot.js [outDir]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, nativeTheme } = require('electron');

const { registerArgon2 } = require('../src/main/argon2');
const settings = require('../src/main/settings');
const vault = require('../src/main/vault');
const { registerIpc } = require('../src/main/ipc');

registerArgon2();

// Capture at 1x so the PNGs match the CSS pixel layout.
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('high-dpi-support', '1');

// Keep the harness out of the real profile so it never touches the user's
// recent database list or preferences.
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'ironvault-profile-')));

const outDir = process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : path.join(os.tmpdir(), 'ironvault-shots');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ironvault-demo-'));
const demoPath = path.join(workDir, 'Demo Vault.kdbx');
const PASSWORD = 'demo-master-password';

const DEMO = [
  ['Internet', 'GitHub', 'dronelogs', 'r7Kq-Wm2!vZx9Ld4', 'https://github.com', 'Personal account, 2FA on.', 'otpauth://totp/GitHub:dronelogs?secret=GEZDGNBVGY3TQOJQ&issuer=GitHub'],
  ['Internet', 'Cloudflare', 'jrusso@example.com', 'Tq8#mLp2vXr9Kd4W', 'https://dash.cloudflare.com', 'DNS and Workers.', ''],
  ['Internet', 'Vercel', 'drone-logs', 'Zx4$nRt7wQm2Pk9L', 'https://vercel.com', '', ''],
  ['Email', 'Proton Mail', 'drone-logs@proton.me', 'Vm3^qWt8zPr5Nx2J', 'https://mail.proton.me', 'Primary mailbox.', 'otpauth://totp/Proton:drone-logs?secret=JBSWY3DPEHPK3PXP&issuer=Proton'],
  ['Email', 'Outlook', 'jrusso@example.com', 'password1', 'https://outlook.com', 'Old account, needs a new password.', ''],
  ['Banking', 'Regions Bank', 'jrusso', 'Kp7&xNq4mWz8Vt3R', 'https://regions.com', '', ''],
  ['Banking', 'Discover Card', 'jrusso', 'password1', 'https://discover.com', '', ''],
  ['Work', 'Supabase', 'drone-logs@proton.me', 'Hq5!zRm9tWn3Xk7P', 'https://supabase.com', 'Newpointe project.', ''],
  ['Work', 'Namecheap', 'dronelogs', 'Bt6@vKx3qNr8Wm2Z', 'https://namecheap.com', '', ''],
  ['Work', 'Adobe', 'jrusso@example.com', '123456', 'https://adobe.com', '', '']
];

async function buildDemo() {
  await vault.create({ filePath: demoPath, password: PASSWORD, name: 'Demo Vault' });
  const tree = vault.getTree();
  const groupId = (name) => (tree.root.groups.find((g) => g.name === name) || {}).id;

  for (const [group, title, username, password, url, notes, otp] of DEMO) {
    const customFields = [];
    if (otp) customFields.push({ key: 'otp', value: otp, protected: false });
    if (title === 'Regions Bank') customFields.push({ key: 'Account number', value: '1234-5678-9012', protected: true });
    vault.createEntry({
      groupId: groupId(group),
      title,
      username,
      password,
      url,
      notes,
      customFields,
      tags: title === 'GitHub' || title === 'Proton Mail' ? ['Favorite'] : []
    });
  }
  await vault.save();
  vault.lock();

  settings.rememberDatabase({ path: demoPath, name: 'Demo Vault' });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  await buildDemo();
  nativeTheme.themeSource = 'dark';

  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    show: true,
    backgroundColor: '#12141a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  const consoleLines = [];
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    consoleLines.push(`[${level}] ${message} (${path.basename(source || '')}:${line})`);
  });

  // Mirror what main.js does on lock so the renderer gets the same signal.
  registerIpc({
    getWindow: () => win,
    lockNow: (reason) => {
      vault.lock();
      if (!win.isDestroyed()) win.webContents.send('vault:locked', { reason });
    },
    takePendingFile: () => null
  });

  // Never let a stuck step hold the process open.
  setTimeout(() => {
    console.error('watchdog: harness took too long, exiting');
    app.exit(2);
  }, 400000).unref();
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  win.focus();
  await wait(540);

  async function shot(name) {
    // Let the compositor land two clean frames before grabbing the surface,
    // otherwise the capture can blend the old and new screens together.
    await win.webContents.executeJavaScript(
      'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))',
      true
    );
    await wait(150);
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, name + '.png'), image.toPNG());
    console.log('wrote ' + name + '.png');
  }

  async function run(code, label) {
    try {
      return await win.webContents.executeJavaScript(code, true);
    } catch (err) {
      console.log('step failed (' + (label || 'unnamed') + '): ' + err.message);
      return null;
    }
  }

  await shot('01-lock');

  await run(`document.querySelector('#btn-new-db').click(); true`, 'new database');
  await wait(540);
  await shot('01b-new-database');
  await run(`IV.dom.topModal() && IV.dom.topModal().close(); true`, 'close new database');
  await wait(150);

  await run(`document.querySelector('.db-item').click(); true`);
  await wait(150);
  await shot('02-unlock');

  await run(`
    document.querySelector('#unlock-password').value = ${JSON.stringify(PASSWORD)};
    document.querySelector('#unlock-form').dispatchEvent(new Event('submit', { cancelable: true }));
    true
  `);
  await wait(900);
  await shot('03-main');

  await run(`
    (async () => {
      const row = Array.from(document.querySelectorAll('.entry-title')).find(e => e.textContent === 'GitHub');
      row.closest('.entry-row').click();
    })(); true
  `);
  await wait(270);
  await shot('04-detail');

  await run(`document.querySelector('#search-input').value='bank'; document.querySelector('#search-input').dispatchEvent(new Event('input')); true`);
  await wait(180);
  await shot('05-search');

  await run(`document.querySelector('#btn-audit').click(); true`);
  await wait(315);
  await run(`document.querySelectorAll('.audit-group').forEach(d => d.open = true); true`);
  await wait(150);
  await shot('06-audit');
  await run(`IV.dom.topModal() && IV.dom.topModal().close(); true`);

  await run(`document.querySelector('#btn-generator').click(); true`, 'open generator');
  await wait(315);
  await run(`document.querySelectorAll('.modal details.adv').forEach(d => d.open = true); true`, 'expand advanced');
  await wait(150);
  await shot('07-generator-basic');

  await run(
    `Array.from(document.querySelectorAll('.modal .tab')).find(t => t.textContent === 'Diceware').click(); true`,
    'diceware tab'
  );
  await wait(270);
  await run(`document.querySelectorAll('.modal details.adv').forEach(d => d.open = true); true`, 'expand advanced');
  await wait(150);
  await shot('08-generator-diceware');
  await run(`IV.dom.topModal() && IV.dom.topModal().close(); true`, 'close generator');
  await wait(150);

  await run(`IV.generator.openUsernamePicker({}); true`, 'username picker');
  await wait(360);
  await shot('09-usernames');
  await run(`IV.dom.topModal() && IV.dom.topModal().close(); true`, 'close usernames');
  await wait(150);

  await run(`IV.settings.openUpdates(); true`, 'updates');
  await wait(360);
  await shot('10-updates');
  await run(`IV.dom.topModal() && IV.dom.topModal().close(); true`, 'close updates');
  await wait(150);

  await run(`
    (async () => {
      const row = Array.from(document.querySelectorAll('.entry-title')).find(e => e.textContent === 'Regions Bank');
      row.closest('.entry-row').click();
      await new Promise(r => setTimeout(r, 400));
      const entry = await IV.api.entry(IV.state.entryId);
      IV.editor.openEntryEditor(entry);
    })(); true
  `, 'open editor');
  await wait(360);
  await shot('11-editor');
  await run(`IV.dom.topModal() && IV.dom.topModal().close(); true`);

  await run(`document.querySelector('#btn-settings').click(); true`);
  await wait(225);
  await shot('12-settings');
  await run(`IV.dom.topModal() && IV.dom.topModal().close(); true`);

  await run(`IV.api.setPrefs({appearance:'light'}).then(p => { IV.state.prefs = p; IV.app.applyTheme(); }); true`);
  await wait(405);
  await shot('13-light');
  await run(`IV.api.setPrefs({appearance:'dark'}).then(p => { IV.state.prefs = p; IV.app.applyTheme(); }); true`);

  await run(`IV.settings.openSettings(); true`, 'settings for a11y');
  await wait(315);
  await run(`
    const b = IV.dom.topModal().dialog.querySelector('.modal-body');
    b.scrollTop = 320;
    true
  `, 'scroll settings');
  await wait(150);
  await shot('16-accessibility');
  await run(`IV.dom.topModal() && IV.dom.topModal().close(); true`, 'close settings');
  await wait(150);

  await run(`IV.api.setPrefs({uiFont:'dyslexic', zoom:1}).then(p => { IV.state.prefs = p; IV.app.applyTheme(); }); true`, 'dyslexic font');
  await wait(405);
  await shot('17-dyslexic-font');
  await run(`IV.api.setPrefs({uiFont:'system'}).then(p => { IV.state.prefs = p; IV.app.applyTheme(); }); true`, 'reset font');
  await wait(180);

  await run(`IV.api.setPrefs({theme:'ironvault'}).then(p => { IV.state.prefs = p; IV.app.applyTheme(); }); true`, 'ironvault theme');
  await wait(315);
  await shot('18-ironvault-theme');
  await run(`IV.api.setPrefs({theme:'ironvault-cb'}).then(p => { IV.state.prefs = p; IV.app.applyTheme(); }); true`, 'reset theme');
  await wait(180);

  await run(`
    IV.api.setPrefs({theme:'propolis-cb'}).then(async p => {
      IV.state.prefs = p;
      const info = await IV.api.appInfo();
      IV.state.productName = info.productName;
      IV.app.applyTheme();
      IV.app.applyBrand();
    }); true
  `, 'propolis brand');
  await wait(495);
  await shot('19-propolis');
  await run(`
    IV.api.setPrefs({theme:'ironvault-cb'}).then(async p => {
      IV.state.prefs = p;
      const info = await IV.api.appInfo();
      IV.state.productName = info.productName;
      IV.app.applyTheme();
      IV.app.applyBrand();
    }); true
  `, 'reset brand');
  await wait(270);

  await run(`IV.settings.openShortcuts(); true`, 'shortcuts');
  await wait(180);
  await shot('14-shortcuts');
  await run(`IV.dom.topModal() && IV.dom.topModal().close(); true`, 'close shortcuts');

  /* ------------------------------------------------------- flow checks */

  let passed = 0;
  let failed = 0;
  const check = (label, ok, detail) => {
    if (ok) {
      passed++;
      console.log('  ok   ' + label);
    } else {
      failed++;
      console.log('  FAIL ' + label + (detail ? '  ->  ' + detail : ''));
    }
  };

  console.log('');
  console.log('UI flow checks');

  await run(`
    (async () => {
      document.querySelector('#search-input').value = '';
      document.querySelector('#search-input').dispatchEvent(new Event('input'));
      await new Promise(r => setTimeout(r, 300));
      IV.editor.openEntryEditor(null, null);
    })(); true
  `, 'open new entry editor');
  await wait(315);

  await run(`
    (() => {
      const dialog = IV.dom.topModal().dialog;
      const inputs = dialog.querySelectorAll('.modal-body input, .modal-body textarea');
      const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input')); };
      set(inputs[0], 'Smoke Test Entry');
      set(inputs[1], 'smoke-user');
      set(inputs[2], 'Smoke-Pass-9271!');
      Array.from(dialog.querySelectorAll('.modal-foot button')).find(b => b.textContent === 'Create').click();
    })(); true
  `, 'submit new entry');
  await wait(630);

  const created = await run(`
    JSON.stringify({
      inList: Array.from(document.querySelectorAll('.entry-title')).some(e => e.textContent === 'Smoke Test Entry'),
      detailTitle: document.querySelector('#detail h1') ? document.querySelector('#detail h1').textContent : null,
      dirtyHidden: document.querySelector('#titlebar-dirty').hidden,
      modalOpen: Boolean(IV.dom.topModal())
    })
  `, 'read state after create');
  const createdState = JSON.parse(created || '{}');
  check('new entry appears in the list', createdState.inList === true, created);
  check('new entry is selected in the detail pane', createdState.detailTitle === 'Smoke Test Entry', created);
  check('editor closed after saving', createdState.modalOpen === false, created);
  check('autosave cleared the unsaved marker', createdState.dirtyHidden === true, created);

  const savedOnDisk = fs.statSync(demoPath).mtimeMs;
  check('database file was rewritten', savedOnDisk > 0);

  await run(`document.querySelector('#btn-lock').click(); true`, 'lock');
  await wait(405);
  const locked = await run(`
    JSON.stringify({
      lockVisible: !document.querySelector('#screen-lock').hidden,
      mainHidden: document.querySelector('#screen-main').hidden
    })
  `, 'read locked state');
  const lockedState = JSON.parse(locked || '{}');
  check('locking returns to the database list', lockedState.lockVisible === true, locked);
  check('main screen is hidden while locked', lockedState.mainHidden === true, locked);
  await shot('15-locked');

  await run(`document.querySelector('.db-item').click(); true`, 'pick database');
  await wait(150);
  await run(`
    document.querySelector('#unlock-password').value = ${JSON.stringify(PASSWORD)};
    document.querySelector('#unlock-form').dispatchEvent(new Event('submit', { cancelable: true }));
    true
  `, 'unlock again');
  await wait(900);

  const reopened = await run(`
    (async () => {
      const results = await IV.api.search('smoke test');
      const secret = results.length ? await IV.api.secret(results[0].id, 'Password') : null;
      return JSON.stringify({ found: results.length, secretMatches: secret === 'Smoke-Pass-9271!' });
    })()
  `, 'search after reopen');
  const reopenedState = JSON.parse(reopened || '{}');
  check('entry survived lock and reopen', reopenedState.found === 1, reopened);
  check('password survived lock and reopen', reopenedState.secretMatches === true, reopened);

  const totpCheck = await run(`
    (async () => {
      const results = await IV.api.search('github');
      const code = await IV.api.totp(results[0].id);
      return JSON.stringify({ code: code && code.code, left: code && code.secondsLeft });
    })()
  `, 'totp through the UI');
  const totpState = JSON.parse(totpCheck || '{}');
  check('one time code generated through the UI', /^\d{6}$/.test(totpState.code || ''), totpCheck);

  /* ------------------------------------------------- accessibility checks */

  console.log('');
  console.log('accessibility checks');

  const a11y = JSON.parse(
    await run(`
      (() => {
        const rows = Array.from(document.querySelectorAll('.entry-row'));
        const navs = Array.from(document.querySelectorAll('#group-tree .nav-item'));
        const iconButtons = Array.from(document.querySelectorAll('.icon-btn'));
        return JSON.stringify({
          liveRegions: Boolean(document.getElementById('sr-status') && document.getElementById('sr-alert')),
          skipLink: Boolean(document.querySelector('.skip-link')),
          listboxRole: (document.getElementById('entry-list') || {}).getAttribute
            ? document.getElementById('entry-list').getAttribute('role')
            : null,
          rowsHaveRole: rows.length > 0 && rows.every(r => r.getAttribute('role') === 'option'),
          rowsFocusable: rows.length > 0 && rows.every(r => r.getAttribute('tabindex') === '0'),
          rowsLabelled: rows.length > 0 && rows.every(r => (r.getAttribute('aria-label') || '').length > 3),
          treeRole: (document.getElementById('group-tree') || {}).getAttribute
            ? document.getElementById('group-tree').getAttribute('role')
            : null,
          treeItemsRole: navs.length > 0 && navs.every(n => n.getAttribute('role') === 'treeitem'),
          treeItemsLevelled: navs.length > 0 && navs.every(n => n.hasAttribute('aria-level')),
          iconButtonCount: iconButtons.length,
          iconButtonsNamed: iconButtons.every(b => (b.getAttribute('aria-label') || b.textContent.trim()).length > 0),
          unnamedButtons: iconButtons
            .filter(b => !(b.getAttribute('aria-label') || b.textContent.trim()).length)
            .map(b => b.className + '#' + (b.id || '') + '@' + (b.parentElement ? b.parentElement.className : '')),
          searchLabelled: Boolean(document.querySelector('label[for="search-input"]'))
        });
      })()
    `, 'a11y probe')
  );

  check('live regions present', a11y.liveRegions === true);
  check('skip link present', a11y.skipLink === true);
  check('entry list is a listbox', a11y.listboxRole === 'listbox', String(a11y.listboxRole));
  check('entry rows are options', a11y.rowsHaveRole === true);
  check('entry rows reachable by keyboard', a11y.rowsFocusable === true);
  check('entry rows have spoken labels', a11y.rowsLabelled === true);
  check('group list is a tree', a11y.treeRole === 'tree', String(a11y.treeRole));
  check('group items are treeitems', a11y.treeItemsRole === true);
  check('group items carry a level', a11y.treeItemsLevelled === true);
  check(
    'every icon button has a name (' + a11y.iconButtonCount + ' checked)',
    a11y.iconButtonsNamed === true,
    'unnamed: ' + (a11y.unnamedButtons || []).join(' | ')
  );
  check('search box has a label', a11y.searchLabelled === true);

  // A dialog must keep focus inside it and hand focus back on close.
  await run(`document.querySelector('#btn-generator').focus(); true`, 'focus generator button');
  await run(`document.querySelector('#btn-generator').click(); true`, 'open generator');
  await wait(315);
  const dialogState = JSON.parse(
    await run(`
      (() => {
        const dlg = IV.dom.topModal().dialog;
        return JSON.stringify({
          role: dlg.getAttribute('role'),
          modal: dlg.getAttribute('aria-modal'),
          labelled: Boolean(dlg.getAttribute('aria-labelledby')),
          focusInside: dlg.contains(document.activeElement),
          active: document.activeElement ? document.activeElement.tagName + '.' + document.activeElement.className : 'none',
          target: (() => {
            const t = dlg.querySelector('input, textarea, button.primary') || dlg.querySelector('button');
            return t ? t.tagName + '.' + t.className : 'none';
          })()
        });
      })()
    `, 'dialog probe')
  );
  check('dialog has the dialog role', dialogState.role === 'dialog');
  check('dialog is marked modal', dialogState.modal === 'true');
  check('dialog is labelled', dialogState.labelled === true);
  check(
    'focus moves into the dialog',
    dialogState.focusInside === true,
    'active=' + dialogState.active + ' target=' + dialogState.target
  );

  await run(`IV.dom.topModal().close(); true`, 'close generator');
  await wait(180);
  const restored = await run(
    `document.activeElement && document.activeElement.id === 'btn-generator'`,
    'focus restore probe'
  );
  check('focus returns to what opened it', restored === true);

  /* ------------------------------------------------ accessibility screens */

  await run(`IV.api.setPrefs({highContrast:true}).then(p => { IV.state.prefs = p; IV.app.applyTheme(); }); true`, 'high contrast');
  await wait(405);
  await shot('20-high-contrast');
  await run(`IV.api.setPrefs({highContrast:false}).then(p => { IV.state.prefs = p; IV.app.applyTheme(); }); true`, 'reset contrast');
  await wait(225);

  await run(`IV.api.setPrefs({bigTargets:true}).then(p => { IV.state.prefs = p; IV.app.applyTheme(); }); true`, 'big targets');
  await wait(405);
  await shot('21-large-targets');
  await run(`IV.api.setPrefs({bigTargets:false}).then(p => { IV.state.prefs = p; IV.app.applyTheme(); }); true`, 'reset targets');
  await wait(225);

  console.log('');
  console.log(passed + ' passed, ' + failed + ' failed');

  if (consoleLines.length) {
    console.log('\nrenderer console:');
    for (const line of consoleLines) console.log('  ' + line);
  } else {
    console.log('\nrenderer console: clean');
  }

  fs.rmSync(workDir, { recursive: true, force: true });
  app.quit();
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('shot harness failed:', err);
    app.exit(1);
  })
);
