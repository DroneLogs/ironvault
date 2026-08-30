'use strict';

/**
 * One picture, for the website.
 *
 * Same harness as shot.js but rendered at twice the size, because a marketing
 * image is shown large on displays that will not forgive a 1x screenshot, and
 * scaled down looks better than scaled up.
 *
 * It builds the same throwaway demo vault, opens an entry that has something
 * worth showing in it, and writes one PNG. Nothing here touches a real
 * database: the profile and the vault are both temporary directories.
 *
 *   npx electron scripts/hero.js [outDir]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const { registerArgon2 } = require('../src/main/argon2');
const settings = require('../src/main/settings');
const vault = require('../src/main/vault');
const { registerIpc } = require('../src/main/ipc');

registerArgon2();

const SCALE = 2;
const WIDTH = 1280;
const HEIGHT = 800;

app.commandLine.appendSwitch('force-device-scale-factor', String(SCALE));
app.commandLine.appendSwitch('high-dpi-support', '1');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'propolis-hero-profile-')));

const outDir = process.argv[2] || path.join(os.homedir(), 'Pictures', 'Propolis screenshots');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'propolis-hero-'));
const demoPath = path.join(workDir, 'Demo Vault.kdbx');
const PASSWORD = 'demo-master-password';

const DEMO = [
  ['Internet', 'GitHub', 'alex.rivera', 'r7Kq-Wm2!vZx9Ld4', 'https://github.com', 'Personal account, 2FA on.', 'otpauth://totp/GitHub:alex.rivera?secret=GEZDGNBVGY3TQOJQ&issuer=GitHub'],
  ['Internet', 'Cloudflare', 'alex@example.com', 'Tq8#mLp2vXr9Kd4W', 'https://dash.cloudflare.com', 'DNS and Workers.', ''],
  ['Internet', 'Vercel', 'alex.rivera', 'Zx4$nRt7wQm2Pk9L', 'https://vercel.com', '', ''],
  ['Email', 'Proton Mail', 'alex@example.com', 'Vm3^qWt8zPr5Nx2J', 'https://mail.proton.me', 'Primary mailbox.', ''],
  ['Email', 'Outlook', 'alex@example.com', 'password1', 'https://outlook.com', 'Old account, needs a new password.', ''],
  ['Banking', 'First National', 'arivera', 'Kp7&xNq4mWz8Vt3R', 'https://firstnational.example.com', '', ''],
  ['Work', 'Supabase', 'alex@example.com', 'Hq5!zRm9tWn3Xk7P', 'https://supabase.com', 'Staging project.', ''],
  ['Work', 'Namecheap', 'alex.rivera', 'Bt6@vKx3qNr8Wm2Z', 'https://namecheap.com', '', '']
];

async function buildDemo() {
  await vault.create({ filePath: demoPath, password: PASSWORD, name: 'Demo Vault' });
  const tree = vault.getTree();
  const groupId = (name) => (tree.root.groups.find((g) => g.name === name) || {}).id;
  for (const [group, title, username, password, url, notes, otp] of DEMO) {
    const customFields = [];
    if (otp) customFields.push({ key: 'otp', value: otp, protected: false });
    vault.createEntry({
      groupId: groupId(group),
      title,
      username,
      password,
      url,
      notes,
      tags: title === 'GitHub' ? ['Favorite'] : [],
      customFields
    });
  }
  await vault.save();
  vault.lock();
  settings.rememberDatabase({ path: demoPath, name: 'Demo Vault' });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  await buildDemo();

  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: true,
    backgroundColor: '#16181c',
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  registerIpc({ getWindow: () => win, lockNow: () => {} });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  win.focus();
  await wait(900);

  const run = (js) => win.webContents.executeJavaScript(js, true);

  // Driven through the real unlock form rather than the api, because that is
  // what leaves the renderer in the state a person would actually see.
  await run(`document.querySelector('.db-item').click(); true`);
  await wait(300);
  await run(`
    document.querySelector('#unlock-password').value = ${JSON.stringify(PASSWORD)};
    document.querySelector('#unlock-form').dispatchEvent(new Event('submit', { cancelable: true }));
    true
  `);
  await wait(1200);

  await run(`
    (function () {
      const rows = Array.from(document.querySelectorAll('.entry-row, [role="option"]'));
      const row = rows.find((r) => /GitHub/.test(r.textContent));
      if (row) row.click();
      return Boolean(row);
    })()
  `);
  await wait(900);

  fs.mkdirSync(outDir, { recursive: true });
  // Two clean frames before grabbing, or the capture can come back empty or
  // blended between the old screen and the new one.
  await run('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))');
  await wait(300);
  const image = await win.webContents.capturePage();
  const file = path.join(outDir, 'hero.png');
  fs.writeFileSync(file, image.toPNG());
  const size = image.getSize();
  console.log('wrote ' + file + '  ' + size.width + 'x' + size.height);

  vault.lock();
  fs.rmSync(workDir, { recursive: true, force: true });
  app.exit(0);
});
