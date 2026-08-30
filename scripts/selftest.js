'use strict';

/**
 * Exercises the vault module without Electron, so the KDBX layer can be checked
 * on its own: node scripts/selftest.js
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

require('../src/main/argon2').registerArgon2();
const vault = require('../src/main/vault');
const itemtypes = require('../src/main/itemtypes');
const strength = require('../src/main/strength');
const generator = require('../src/main/generator');
const wordlists = require('../src/main/wordlists');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'propolis-test-'));
const dbPath = path.join(tmpDir, 'Test.kdbx');
const keyFilePath = path.join(tmpDir, 'Test.keyx');
const attachPath = path.join(tmpDir, 'note.txt');

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed++;
    console.log('  ok   ' + label);
  } else {
    failed++;
    console.log('  FAIL ' + label + (detail ? '  ->  ' + detail : ''));
  }
}

async function main() {
  console.log('Propolis self test');
  console.log('workspace: ' + tmpDir);

  fs.writeFileSync(attachPath, 'attachment contents\n');
  fs.writeFileSync(keyFilePath, Buffer.from('a fixed key file for the test'));

  console.log('\ncreate');
  let info = await vault.create({ filePath: dbPath, password: 'master-pass-1', name: 'Test Vault' });
  check('file written', fs.existsSync(dbPath));
  check('reports KDBX 4', info.version.startsWith('4'), info.version);
  check('uses Argon2', /argon2/i.test(info.kdf), info.kdf);
  check('seed groups created', info.groupCount >= 4, String(info.groupCount));

  console.log('\nentries');
  const tree = vault.getTree();
  const internet = tree.root.groups.find((g) => g.name === 'Internet');
  check('found seed group', Boolean(internet));

  const created = vault.createEntry({
    groupId: internet.id,
    title: 'GitHub',
    username: 'dronelogs',
    password: 'S3cret-Passw0rd!',
    url: 'https://github.com',
    notes: 'personal account',
    customFields: [
      { key: 'Recovery', value: 'a1b2-c3d4', protected: true },
      { key: 'Plan', value: 'Free', protected: false },
      { key: 'otp', value: 'otpauth://totp/GitHub:dronelogs?secret=GEZDGNBVGY3TQOJQ&issuer=GitHub', protected: false }
    ],
    tags: ['dev']
  });
  check('entry created', created.title === 'GitHub');
  check('password hidden in payload', !JSON.stringify(created).includes('S3cret-Passw0rd!'));
  check('custom field kept', created.customFields.some((f) => f.key === 'Plan' && f.value === 'Free'));
  check('protected field value withheld', created.customFields.some((f) => f.key === 'Recovery' && f.protected && f.value === ''));
  check('totp detected', created.hasTotp && created.totp.digits === 6);

  const secret = vault.getSecret(created.id, 'Password');
  check('secret retrievable on request', secret === 'S3cret-Passw0rd!', secret);
  const recovery = vault.getSecret(created.id, 'Recovery');
  check('protected custom field retrievable', recovery === 'a1b2-c3d4', recovery);

  const code = vault.getTotp(created.id);
  check('totp generated', /^\d{6}$/.test(code.code), JSON.stringify(code));
  check('totp countdown sane', code.secondsLeft > 0 && code.secondsLeft <= 30, String(code.secondsLeft));

  console.log('\nedit and history');
  const updated = vault.updateEntry(created.id, {
    title: 'GitHub',
    username: 'dronelogs',
    password: 'a-new-password-2',
    url: 'https://github.com',
    notes: 'personal account',
    customFields: created.customFields.map((f) => ({ ...f, unchanged: f.protected }))
  });
  check('history recorded', updated.history.length === 1, String(updated.history.length));
  check('password changed', vault.getSecret(created.id, 'Password') === 'a-new-password-2');
  check('untouched protected field survived edit', vault.getSecret(created.id, 'Recovery') === 'a1b2-c3d4');

  const restored = vault.restoreHistory(created.id, 0);
  check('history restored old password', vault.getSecret(created.id, 'Password') === 'S3cret-Passw0rd!');
  check('restore itself is versioned', restored.history.length >= 1);

  console.log('\nattachments');
  const withFile = await vault.addAttachment(created.id, attachPath);
  check('attachment added', withFile.attachments.length === 1 && withFile.attachments[0].name === 'note.txt');
  check('attachment size', withFile.attachments[0].size === fs.statSync(attachPath).size);
  const outPath = path.join(tmpDir, 'extracted.txt');
  await vault.extractAttachment(created.id, 'note.txt', outPath);
  check('attachment extracted intact', fs.readFileSync(outPath, 'utf8') === 'attachment contents\n');

  console.log('\nsearch and audit');
  vault.createEntry({ groupId: internet.id, title: 'Gitlab', username: 'dronelogs', password: 'S3cret-Passw0rd!' });
  vault.createEntry({ groupId: internet.id, title: 'Old Forum', username: 'jr', password: '123456' });
  check('search by title', vault.search('github').some((e) => e.title === 'GitHub'));
  check('search by username', vault.search('dronelogs').length >= 2);
  check('search ranks exact title first', vault.search('gitlab')[0].title === 'Gitlab');
  check('search misses unrelated', vault.search('zzzznothing').length === 0);

  const report = vault.audit();
  check('audit finds weak password', report.weak.some((e) => e.title === 'Old Forum'));
  check('audit finds duplicate pair', report.duplicates.some((group) => group.length === 2));

  console.log('\ngroups and recycle bin');
  const sub = vault.createGroup(internet.id, 'Sub group');
  vault.moveEntry(created.id, sub.id);
  check('entry moved', vault.getEntry(created.id).groupId === sub.id);
  vault.deleteEntry(created.id);
  check('delete goes to recycle bin', vault.getEntry(created.id).inRecycleBin);
  check('recycle scope lists it', vault.listEntries({ scope: 'recycle' }).length === 1);
  vault.restoreEntry(created.id, sub.id);
  check('restore from recycle bin', vault.getEntry(created.id).inRecycleBin === false);

  const dup = vault.duplicateEntry(created.id);
  check('duplicate made', dup.title === 'GitHub (copy)');
  check('duplicate has its own id', dup.id !== created.id);
  check('duplicate kept the password', vault.getSecret(dup.id, 'Password') === 'S3cret-Passw0rd!');
  vault.deleteEntry(dup.id, { permanent: true });
  check('permanent delete removed it', vault.listEntries({ scope: 'all' }).every((e) => e.id !== dup.id));

  console.log('\nword lists');
  const catalogue = wordlists.catalogue();
  check('word lists present', catalogue.length >= 20, String(catalogue.length));
  check('standard lists', catalogue.filter((c) => c.category === 'standard').length >= 8);
  check('fandom lists', catalogue.filter((c) => c.category === 'fandom').length >= 5);
  const lotr = wordlists.words('fandom-lotr');
  check('the Middle-earth list is 4000 words', lotr.length === 4000, String(lotr.length));
  check('and is plain ASCII, so it can be typed', lotr.every((w) => /^[a-z]{3,12}$/.test(w)));
  check('with no duplicates', new Set(lotr).size === lotr.length);
  check('language lists', catalogue.filter((c) => c.category === 'languages').length >= 11);
  check('EFF Large is 7776 words', (catalogue.find((c) => c.key === 'eff-large') || {}).count === 7776);
  const effWords = wordlists.words('eff-large');
  check('every list entry is a single token', effWords.every((w) => /^\S+$/.test(w)));
  check('no duplicates within a list', new Set(effWords).size === effWords.length);
  check('name lists loaded', wordlists.names('first').length > 1000 && wordlists.names('surname').length > 1000);

  console.log('\nbasic generator');
  const basic = generator.generateBasic({
    length: 24,
    groups: { upper: true, lower: true, digits: true, symbols: true },
    easyReadOnly: true,
    nonAmbiguousOnly: true,
    pickFromEveryGroup: true
  });
  check('length honoured', basic.password.length === 24, basic.password);
  check(
    'every group represented',
    /[A-Z]/.test(basic.password) &&
      /[a-z]/.test(basic.password) &&
      /[0-9]/.test(basic.password) &&
      /[^A-Za-z0-9]/.test(basic.password),
    basic.password
  );
  check('easy read filter applied', !/[0125lIOSZ]/.test(basic.password), basic.password);
  check('non ambiguous filter applied', !/[{}[\]()/\\'"`~,;:.<>]/.test(basic.password), basic.password);
  check('reports Strong or better', basic.strength.level >= 3, basic.strength.summary);
  check(
    'summary shape',
    /^[A-Za-z ]+ \(\d+ \/ \d+\.\d bits \/ .+\)$/.test(basic.strength.summary),
    basic.strength.summary
  );

  const digitsOnly = generator.generateBasic({
    length: 8,
    groups: { digits: true },
    easyReadOnly: false,
    nonAmbiguousOnly: false,
    pickFromEveryGroup: false
  });
  check('single group works', /^[0-9]{8}$/.test(digitsOnly.password), digitsOnly.password);
  check(
    'entropy matches the pool',
    Math.abs(digitsOnly.strength.bits - 8 * Math.log2(10)) < 0.2,
    String(digitsOnly.strength.bits)
  );

  const excluded = generator.generateBasic({
    length: 30,
    groups: { lower: true },
    excludedCharacters: 'aeiou',
    easyReadOnly: false,
    nonAmbiguousOnly: false
  });
  check('excluded characters removed', !/[aeiou]/.test(excluded.password), excluded.password);

  let noCharsThrew = false;
  try {
    generator.generateBasic({
      length: 10,
      groups: { lower: true },
      excludedCharacters: 'abcdefghijklmnopqrstuvwxyz'
    });
  } catch (err) {
    noCharsThrew = err.code === 'NO_CHARACTERS';
  }
  check('empty character set is rejected', noCharsThrew);

  console.log('\ndiceware generator');
  const dice = generator.generateDiceware({
    wordCount: 6,
    wordLists: ['eff-large'],
    separator: '-',
    casing: 'title'
  });
  check('six words', dice.password.split('-').length === 6, dice.password);
  check('title cased', dice.password.split('-').every((w) => /^[A-Z][a-z]*$/.test(w)), dice.password);
  check('12.9 bits per word', Math.abs(dice.bitsPerWord - 12.92) < 0.01, String(dice.bitsPerWord));
  check('entropy is words times bits', Math.abs(dice.strength.bits - 6 * 12.92) < 0.1, String(dice.strength.bits));

  const oneWord = generator.generateDiceware({ wordCount: 1, wordLists: ['eff-short-1'], casing: 'lower' });
  check('single word passphrase', /^[a-z]+$/.test(oneWord.password), oneWord.password);
  check('short list is 1296 words', oneWord.poolSize === 1296, String(oneWord.poolSize));

  const upperDice = generator.generateDiceware({
    wordCount: 3,
    wordLists: ['eff-large'],
    casing: 'upper',
    separator: '_'
  });
  check('uppercase casing', upperDice.password === upperDice.password.toUpperCase(), upperDice.password);

  const loaded = generator.generateDiceware({
    wordCount: 4,
    wordLists: ['eff-large'],
    casing: 'title',
    addNumber: true,
    addSymbol: true,
    addLatin1: true,
    salt: 'suffix'
  });
  check('added a digit', /[0-9]/.test(loaded.password), loaded.password);
  check('added a Latin-1 character', /[¡-ÿ]/.test(loaded.password), loaded.password);
  check('extras raise the entropy', loaded.strength.bits > 4 * 12.92, String(loaded.strength.bits));

  const leet = generator.generateDiceware({
    wordCount: 5,
    wordLists: ['eff-large'],
    casing: 'lower',
    leetspeak: 'basic-all'
  });
  check('leetspeak substitutes', /[0134579]/.test(leet.password), leet.password);

  const mixed = generator.generateDiceware({ wordCount: 3, wordLists: ['eff-large', 'eff-short-1'] });
  check('mixing lists grows the pool', mixed.poolSize > 7776, String(mixed.poolSize));

  console.log('\nstrength reporting');
  check('empty password is Trivial', strength.estimate('').label === 'Trivial');
  check('common password is Trivial', strength.estimate('password').label === 'Trivial');

  // The bands are pinned to Diceware word counts, so the test that matters is
  // that each word count lands in the band named after it.
  const perWord = Math.log(7776) / Math.LN2;
  const bandFor = (words) => strength.categoryFor(words * perWord).label;
  check(
    'the scale is pinned to word counts',
    bandFor(2) === 'Trivial' &&
      bandFor(3) === 'Very Weak' &&
      bandFor(4) === 'Weak' &&
      bandFor(5) === 'Moderate' &&
      bandFor(6) === 'Recommended' &&
      bandFor(7) === 'Strong' &&
      bandFor(10) === 'Quantum Resistant',
    [2, 3, 4, 5, 6, 7, 10].map((n) => n + ':' + bandFor(n)).join(', ')
  );
  check(
    'a six word phrase reads as recommended even from the smallest matching list',
    strength.estimate('Steep-Papyrus-Disarray-Squint-Showpiece-Variably').label === 'Recommended',
    strength.estimate('Steep-Papyrus-Disarray-Squint-Showpiece-Variably').summary
  );
  check(
    'the levels run 0 to 6 with no gaps',
    [0, 40, 55, 70, 80, 100, 200].map((b) => strength.categoryFor(b).level).join() ===
      '0,1,2,3,4,5,6'
  );
  check('crack time caps out', strength.crackTime(200) === '>100m years', strength.crackTime(200));
  check('weak crack time is instant', strength.crackTime(10) === 'instantly', strength.crackTime(10));
  check(
    'character count leads the summary',
    strength.estimate('abcdefgh').summary.includes('(8 / '),
    strength.estimate('abcdefgh').summary
  );

  console.log('\nusername suggestions');
  const usernames = generator.generateUsernames();
  check('four suggestions', usernames.length === 4, String(usernames.length));
  check('handle is dotted and lower case', /^[a-z'-]+\.[a-z'-]+$/.test(usernames[0].value), usernames[0].value);
  check('full name has two parts', usernames[1].value.split(' ').length === 2, usernames[1].value);
  check('random word is a word', /^[a-z]+$/.test(usernames[3].value), usernames[3].value);
  check('no suggestion is an email address', !usernames.some((u) => u.value.includes('@')),
    usernames.map((u) => u.value).join(', '));

  console.log('\nsave and reopen');
  await vault.save();
  check('backup file written', fs.existsSync(dbPath + '.bak'));
  check('no temp files left behind', fs.readdirSync(tmpDir).every((f) => !f.endsWith('.tmp')));
  vault.lock();
  check('locked', vault.isOpen() === false);

  try {
    await vault.open({ filePath: dbPath, password: 'wrong-password' });
    check('wrong password rejected', false, 'it opened anyway');
  } catch (err) {
    check('wrong password rejected', err.code === 'INVALID_KEY', err.message);
  }

  info = await vault.open({ filePath: dbPath, password: 'master-pass-1' });
  check('reopened', info.open === true);
  const reopened = vault.search('github')[0];
  check('entry survived the round trip', Boolean(reopened));
  check('password survived the round trip', vault.getSecret(reopened.id, 'Password') === 'S3cret-Passw0rd!');
  check('attachment survived the round trip', vault.getEntry(reopened.id).attachments.length === 1);
  check('history survived the round trip', vault.getEntry(reopened.id).history.length >= 1);

  console.log('\nstrength');
  const phrase = 'Proactive-Detection-Unviable-Candied-Sarcastic-Brussels';
  const exact = strength.fromEntropy(phrase, 6 * (Math.log(7776) / Math.LN2));
  const guessed = strength.estimate(phrase);
  check(
    'a generated passphrase estimates to what it actually cost',
    Math.abs(guessed.bits - exact.bits) < 0.5,
    exact.bits + ' exact vs ' + guessed.bits + ' estimated'
  );
  check('and is scored on its words', guessed.basis === 'words' && guessed.words === 6, guessed.basis);
  check(
    'a random password is still scored on its characters',
    strength.estimate('Xk9$mQ2!vZ7#pL4@wR8').basis === 'characters',
    strength.estimate('Xk9$mQ2!vZ7#pL4@wR8').basis
  );
  check(
    'two short words are weak however they are punctuated',
    strength.estimate('hello-world').bits < 40,
    String(strength.estimate('hello-world').bits)
  );
  check(
    'words from different lists fall back to the whole vocabulary',
    strength.estimate('correct-horse-battery-staple').basis === 'words',
    strength.estimate('correct-horse-battery-staple').wordList || 'none'
  );
  check(
    'a phrase never estimates above what counting the letters would say',
    strength.estimate(phrase).bits < phrase.length * 6,
    String(strength.estimate(phrase).bits)
  );

  // Every list the generator offers has to be recognised, or a phrase from it
  // falls back to the character estimate and is reported as far stronger than
  // it is. That was true of sixteen of them until 1.5.3.
  let unrecognised = [];
  let overstated = [];
  for (const listed of wordlists.catalogue()) {
    const words = wordlists.words(listed.key);
    const sample = [];
    for (let i = 0; i < 6; i++) sample.push(words[Math.floor(words.length / (i + 2))]);
    const made = sample.map((x) => x.charAt(0).toUpperCase() + x.slice(1)).join('-');
    const read = strength.estimate(made);
    const cost = 6 * (Math.log(words.length) / Math.LN2);
    if (read.basis !== 'words') unrecognised.push(listed.key);
    else if (read.bits > cost + 1) overstated.push(listed.key);
  }
  check('every word list is recognised as words', unrecognised.length === 0, unrecognised.join(', '));
  check('no list overstates what its phrase cost', overstated.length === 0, overstated.join(', '));

  // Reading a random password as a phrase understates it, which is harmless.
  // Failing to read a real phrase overstates it, which is not.
  //
  // This used to assert zero out of 200 and passed most of the time by luck.
  // The true rate is about 4 in 10,000, so a 200 draw run tripped roughly one
  // time in twelve and the suite was quietly flaky. Measured over a larger
  // sample and allowed a ceiling it will not cross by chance: at 0.042 percent
  // the expected count here is under one, and five would take a real
  // regression rather than a bad afternoon.
  //
  // A word read out of a random string still needs the words to be most of the
  // password, so the worst case understates an 18 character password by ten or
  // fifteen bits. That is the safe direction, which is why a ceiling is
  // acceptable here and would not be if the error ran the other way.
  let misread = 0;
  const draws = 2000;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-=_@#$%^&;:,.<>/~';
  for (let i = 0; i < draws; i++) {
    let made = '';
    for (let n = 0; n < 18; n++) made += alphabet[Math.floor(Math.random() * alphabet.length)];
    if (strength.estimate(made).basis === 'words') misread += 1;
  }
  check('random passwords are rarely read as phrases', misread <= 5, misread + ' of ' + draws);

  // Real accented entries, taken from the list rather than invented, since the
  // point is that a non ASCII word is not cut in half by the tokeniser.
  const accented = wordlists.words('lang-icelandic').filter((x) => /[^\x00-\x7f]/.test(x));
  const accentedPhrase = accented
    .slice(0, 6)
    .map((x) => x.charAt(0).toUpperCase() + x.slice(1))
    .join('-');
  check(
    'an accented phrase is recognised as words',
    accented.length === 0 || strength.estimate(accentedPhrase).basis === 'words',
    accentedPhrase + ' -> ' + strength.estimate(accentedPhrase).bits + ' bits'
  );

  check(
    'a hyphenated list entry counts as one word',
    strength.estimate('Absent-mindedly-Absent-mindedly-Absent-mindedly').words <= 4,
    String(strength.estimate('Absent-mindedly-Absent-mindedly-Absent-mindedly').words)
  );

  console.log('\nitem types');
  const card = vault.createEntry({
    title: 'A Card',
    username: 'J RUSSOM',
    password: '4111111111111111',
    customFields: [
      { key: itemtypes.TYPE_FIELD, value: 'card', protected: false },
      { key: 'Expiry', value: '11/29', protected: false },
      { key: 'Security code', value: '123', protected: true }
    ],
    icon: 66
  });
  check('a card is a card', itemtypes.typeOfEntry(card) === 'card', itemtypes.typeOfEntry(card));
  check('an ordinary entry is a login', itemtypes.typeOfEntry(created) === 'login', itemtypes.typeOfEntry(created));
  check('an unknown marker falls back to a login', itemtypes.typeOfEntry({ customFields: [{ key: itemtypes.TYPE_FIELD, value: 'spaceship' }] }) === 'login');
  check('a card takes the money icon', card.icon === 66, String(card.icon));
  check('the card number is withheld like a password', !JSON.stringify(card).includes('4111111111111111'));
  await vault.save();
  vault.lock();
  info = await vault.open({ filePath: dbPath, password: 'master-pass-1' });
  const cardAgain = vault.search('A Card')[0];
  check('the card survived the round trip', Boolean(cardAgain));
  check(
    'it is still a card after the round trip',
    cardAgain && itemtypes.typeOfEntry(vault.getEntry(cardAgain.id)) === 'card'
  );
  check(
    'the card number survived the round trip',
    cardAgain && vault.getSecret(cardAgain.id, 'Password') === '4111111111111111'
  );
  check(
    'the protected security code survived',
    cardAgain && vault.getSecret(cardAgain.id, 'Security code') === '123'
  );
  check(
    'every type declares a name and an icon',
    itemtypes.choices().every((t) => t.name && typeof t.icon === 'number'),
    itemtypes.choices().map((t) => t.key).join(', ')
  );

  console.log('\nkey file and password change');
  await vault.changeCredentials({ password: 'master-pass-2', keyFilePath });
  vault.lock();
  try {
    await vault.open({ filePath: dbPath, password: 'master-pass-2' });
    check('key file now required', false, 'opened without the key file');
  } catch (err) {
    check('key file now required', err.code === 'INVALID_KEY', err.message);
  }
  info = await vault.open({ filePath: dbPath, password: 'master-pass-2', keyFilePath });
  check('opens with password and key file', info.open === true);
  vault.lock();

  console.log('\nKDBX 3 compatibility');
  const legacyPath = path.join(tmpDir, 'Legacy.kdbx');
  const legacy = await vault.create({ filePath: legacyPath, password: 'legacy', name: 'Legacy', format: 3 });
  check('created as KDBX 3', legacy.version.startsWith('3'), legacy.version);
  check('KDBX 3 uses AES-KDF', legacy.kdf === 'AES-KDF', legacy.kdf);
  vault.createEntry({ groupId: null, title: 'Legacy entry', password: 'legacy-pw' });
  await vault.save();
  vault.lock();
  await vault.open({ filePath: legacyPath, password: 'legacy' });
  check('KDBX 3 round trip', vault.getSecret(vault.search('legacy entry')[0].id, 'Password') === 'legacy-pw');
  vault.lock();


  // The key derivation behind PIN unlock and the duress PIN shipped with a
  // maxmem set to exactly what scrypt needs, and Node requires more than that,
  // so every call threw and neither feature could ever have worked. Nothing
  // else exercises this path: security.js pulls in electron, so the self test
  // cannot require it, and the UI harness never sets a PIN.
  //
  // So the constants are read out of the real file and run for real. Copying
  // them here instead would pass while the app stayed broken.
  console.log('\nkey derivation for PIN unlock');
  {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'security.js'), 'utf8');
    // SCRYPT_MAXMEM is written in terms of the other three, so they have to be
    // in scope when it is evaluated rather than read one at a time.
    const expr = (name) => {
      const m = source.match(new RegExp('const ' + name + '\\s*=\\s*([^;]+);'));
      return m ? m[1] : null;
    };
    const names = ['SCRYPT_N', 'SCRYPT_R', 'SCRYPT_P', 'KEY_BYTES', 'SCRYPT_MAXMEM'];
    const found = names.map(expr);
    const [N, r, p, keyBytes, maxmem] = found.every(Boolean)
      ? Function(
          '"use strict";' +
            names.map((n, i) => 'const ' + n + ' = (' + found[i] + ');').join('') +
            'return [' + names.join(',') + '];'
        )()
      : [null, null, null, null, null];

    check('security.js still declares its scrypt parameters',
      [N, r, p, keyBytes, maxmem].every((v) => typeof v === 'number' && v > 0),
      JSON.stringify({ N, r, p, keyBytes, maxmem }));

    const needed = 128 * N * r * p;
    check('maxmem exceeds what scrypt needs rather than equalling it',
      maxmem > needed, maxmem + ' vs ' + needed + ' needed');

    let derived = null;
    let derivationError = null;
    try {
      derived = crypto.scryptSync('1234', Buffer.alloc(16), keyBytes, { N, r, p, maxmem });
    } catch (err) {
      derivationError = err.message.split('\n')[0];
    }
    check('a PIN actually derives a key', derived !== null && derived.length === keyBytes,
      derivationError || String(derived && derived.length));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('\nself test crashed:', err);
  process.exit(1);
});
