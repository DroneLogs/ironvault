'use strict';

/**
 * Exercises the vault module without Electron, so the KDBX layer can be checked
 * on its own: node scripts/selftest.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

require('../src/main/argon2').registerArgon2();
const vault = require('../src/main/vault');
const itemtypes = require('../src/main/itemtypes');
const generator = require('../src/main/generator');
const strength = require('../src/main/strength');
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
  check('fandom lists', catalogue.filter((c) => c.category === 'fandom').length === 4);
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
  check('empty password is Very Weak', strength.estimate('').label === 'Very Weak');
  check('common password is Very Weak', strength.estimate('password').label === 'Very Weak');
  check(
    'categories match Strongbox',
    strength.categoryFor(30).label === 'Weak' &&
      strength.categoryFor(50).label === 'Mediocre' &&
      strength.categoryFor(100).label === 'Strong' &&
      strength.categoryFor(150).label === 'Very Strong' &&
      strength.categoryFor(200).label === 'Overkill'
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
  check('five suggestions', usernames.length === 5, String(usernames.length));
  check('handle is dotted and lower case', /^[a-z'-]+\.[a-z'-]+$/.test(usernames[0].value), usernames[0].value);
  check('full name has two parts', usernames[1].value.split(' ').length === 2, usernames[1].value);
  check('email looks like an address', /^[a-z']+\d{1,3}@[a-z.]+$/.test(usernames[3].value), usernames[3].value);
  check('random word is a word', /^[a-z]+$/.test(usernames[4].value), usernames[4].value);

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

  console.log(`\n${passed} passed, ${failed} failed`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('\nself test crashed:', err);
  process.exit(1);
});
