'use strict';

/**
 * Downloads the accessibility fonts into src/renderer/fonts/.
 *
 * Both are SIL Open Font Licence 1.1, which permits bundling in an application,
 * commercial use included, as long as the licence travels with the font.
 *
 *   node scripts/fetch-fonts.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const OUT_DIR = path.join(__dirname, '..', 'src', 'renderer', 'fonts');

const FONTS = [
  {
    file: 'OpenDyslexic-Regular.woff',
    url: 'https://raw.githubusercontent.com/antijingoist/open-dyslexic/master/woff/OpenDyslexic-Regular.woff',
    credit: 'OpenDyslexic by Abbie Gonzalez, SIL OFL 1.1'
  },
  {
    file: 'OpenDyslexic-Bold.woff',
    url: 'https://raw.githubusercontent.com/antijingoist/open-dyslexic/master/woff/OpenDyslexic-Bold.woff',
    credit: 'OpenDyslexic by Abbie Gonzalez, SIL OFL 1.1',
    optional: true
  },
  {
    file: 'AtkinsonHyperlegible-Regular.woff2',
    url: 'https://raw.githubusercontent.com/googlefonts/atkinson-hyperlegible/main/fonts/webfonts/AtkinsonHyperlegible-Regular.woff2',
    credit: 'Atkinson Hyperlegible by the Braille Institute of America, SIL OFL 1.1'
  },
  {
    file: 'AtkinsonHyperlegible-Bold.woff2',
    url: 'https://raw.githubusercontent.com/googlefonts/atkinson-hyperlegible/main/fonts/webfonts/AtkinsonHyperlegible-Bold.woff2',
    credit: 'Atkinson Hyperlegible by the Braille Institute of America, SIL OFL 1.1',
    optional: true
  }
];

function download(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    const request = https.get(url, { headers: { 'User-Agent': 'ironvault-build' }, timeout: 45000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).toString(), redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy();
      reject(new Error('timed out'));
    });
  });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const notes = ['# Bundled fonts', ''];
  let failed = 0;

  for (const font of FONTS) {
    process.stdout.write(font.file.padEnd(38));
    try {
      const buffer = await download(font.url);
      // A WOFF starts "wOFF", a WOFF2 starts "wOF2". Anything else is an error page.
      const magic = buffer.toString('ascii', 0, 4);
      if (magic !== 'wOFF' && magic !== 'wOF2') throw new Error('not a font file (got "' + magic + '")');
      fs.writeFileSync(path.join(OUT_DIR, font.file), buffer);
      notes.push('- **' + font.file + '** — ' + font.credit);
      console.log('ok    ' + buffer.length + ' bytes');
    } catch (err) {
      console.log((font.optional ? 'skip  ' : 'FAIL  ') + err.message);
      if (!font.optional) failed++;
    }
  }

  notes.push(
    '',
    'Both families are licensed under the SIL Open Font Licence 1.1, which allows',
    'bundling inside an application, including a commercial one, provided the licence',
    'accompanies the font and the font is not sold on its own.',
    '',
    'OpenDyslexic weights the bottom of each letter so characters are harder to rotate',
    'or flip when reading. Atkinson Hyperlegible pulls apart the shapes that low vision',
    'readers confuse most, such as I, l, and 1.'
  );
  fs.writeFileSync(path.join(OUT_DIR, 'FONTS.md'), notes.join('\n') + '\n', 'utf8');

  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
