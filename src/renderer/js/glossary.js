/* Plain explanations for the jargon.

   A password manager is full of words that mean nothing until someone tells
   you: diceware, key file, Argon2, KDF, TOTP, duress. Each one here is a
   collapsed "What is this?" that sits next to the control it describes, so the
   answer is where the question is, and out of the way once you know. */
window.IV = window.IV || {};

(function (IV) {
  'use strict';

  const { h } = IV.dom;

  const TERMS = {
    diceware: {
      title: 'What is Diceware?',
      body: [
        'A passphrase built from whole words picked at random, like Wafer-Ceramics-Refuse-Armored. The name comes from the original method: roll five dice, look the number up in a printed word list, write the word down, repeat.',
        'It is easier to remember and to type than a jumble of symbols, and it is not weaker. Six words from a 7,776 word list is about 78 bits, which no attacker can search through. What makes it strong is that a machine chose the words, not you: a phrase you invent yourself is far more guessable than it feels.',
        'Use it for anything you have to type from memory, above all your master password. Use the Basic tab for everything a password manager will remember on your behalf.'
      ]
    },
    entropy: {
      title: 'What do the bits mean?',
      body: [
        'Bits count how many guesses an attacker would need. Each extra bit doubles that number, so 60 bits is not twice 30 bits, it is a billion times more work.',
        'The line reads: how many characters, how many bits, and how long a well equipped attacker would take at a billion guesses a second. Anything under 40 bits is worth changing. Sixty and up is comfortable for an account that also has two factor authentication.',
        'For a password Propolis generated, the bits are exact, because it knows precisely how many random choices it made. For a password you typed, they are an estimate.'
      ]
    },
    wordlist: {
      title: 'Which word list should I pick?',
      body: [
        'It barely matters for safety, so pick the one you find easiest to read. What matters is the number of words in the list, which the line underneath shows, and Propolis counts that honestly.',
        'EFF Large is the sensible default: 7,776 common English words chosen so no two start with the same four letters, which makes typos obvious. The Short lists trade a little strength for shorter words. Fandom and language lists are the same idea with different vocabulary.'
      ]
    },
    keyfile: {
      title: 'What is a key file?',
      body: [
        'A file that acts as part of your key, on top of the password. With one set, the database needs both: something you know and something you have.',
        'Any file works, as long as it never changes and you never lose it. Keep a copy somewhere safe and separate from the database, on a USB stick for instance. Lose the key file and the database is unopenable, exactly as if you had forgotten the password.'
      ]
    },
    kdf: {
      title: 'KDBX 4, Argon2, what?',
      body: [
        'KDBX is the file format KeePass uses, and version 4 is the current one. Any modern KeePass app reads it, including Strongbox on your phone. Pick 3.1 only if something old refuses to open version 4.',
        'Argon2 is the part that turns your master password into the actual encryption key. It is deliberately slow and memory hungry, so a machine trying billions of guesses is slowed down just as much as it slows your unlock by a fraction of a second. It is the better choice, which is why it is the default.'
      ]
    },
    totp: {
      title: 'What is a one time code?',
      body: [
        'The six digit code that changes every thirty seconds, which a site asks for after your password. Also called TOTP, two factor, or an authenticator code.',
        'When a site offers you a QR code to scan, that image is really just a short web address containing a secret. Paste that address here, or type the secret the site shows underneath it, and Propolis produces the same codes your phone would.',
        'Worth thinking about: keeping the codes in the same place as the passwords is convenient, and it does mean one lock rather than two. Many people accept that. If you would rather not, keep them on your phone.'
      ]
    },
    duress: {
      title: 'What is a duress PIN?',
      body: [
        'A second PIN that does something other than unlock, for a situation where somebody is standing over you demanding you open the database.',
        'It can open a decoy database you prepared earlier, which looks like an ordinary vault holding nothing that matters. Or it can delete this database and all its backups.',
        'Test it before you rely on it, and keep a backup elsewhere if you choose the deleting kind. It cannot be undone and nobody can recover it for you.'
      ]
    },
    placeholders: {
      title: 'What are placeholders?',
      body: [
        'Text in braces that Propolis fills in. {USERNAME} becomes the username of the entry, {TITLE} its title, {S:Account number} a custom field of yours.',
        'They can also point at another entry, so several entries can share one password without you copying it around: {REF:P@T:GitHub} means the password of the entry titled GitHub.',
        'The same braces drive auto-type, where {TAB} and {ENTER} are the keys themselves.'
      ]
    },
    pwned: {
      title: 'Is this safe to run?',
      body: [
        'Yes, and the reason is worth knowing. Your password is never sent. Propolis hashes it, sends only the first five characters of that hash, and gets back every leaked hash starting with those five, usually several hundred. The comparison happens on your machine.',
        'So the service learns that somebody asked about one of a few hundred possibilities, and nothing else. Not the password, not the site, not who you are.'
      ]
    },
    sshagent: {
      title: 'What is an SSH agent?',
      body: [
        'A small helper that holds your SSH keys so ssh and git can use them without the key ever being written to a file on disk.',
        'Start it, run the SSH_AUTH_SOCK line in PowerShell, and any key stored in an entry of this database becomes available for the rest of that session. Lock the database and the keys go with it.'
      ]
    },
    remote: {
      title: 'How does syncing work?',
      body: [
        'Propolis always works on the local copy of the file. Syncing fetches the remote copy, merges the two, and sends the result back.',
        'That is what makes editing offline safe: with no connection you carry on, and the merge happens the next time a sync succeeds. Nothing is thrown away, and newer changes win where both sides edited the same entry.',
        'WebDAV covers Nextcloud, ownCloud, and most NAS boxes. If you use OneDrive, Google Drive, or Dropbox, their desktop app already syncs a folder for you, so just keep the database in it.'
      ]
    },
    readonly: {
      title: 'What does read only do?',
      body: [
        'Opens the database so nothing can change it. Useful on a shared machine, or when you want to look something up without any chance of a slip editing an entry.'
      ]
    }
  };

  /**
   * A question mark in a circle, sized to sit on the same line as a label.
   * Clicking it opens the explanation, so the answer is one click away and
   * takes up no room until somebody wants it.
   */
  function badge(key, { label } = {}) {
    const term = TERMS[key];
    if (!term) return null;
    return h('button', {
      type: 'button',
      class: 'help-badge',
      title: label || term.title,
      'aria-label': label || term.title,
      onClick: (e) => {
        e.preventDefault();
        e.stopPropagation();
        open(key);
      }
    });
  }

  /** The explanation itself. */
  function open(key) {
    const term = TERMS[key];
    if (!term) return;
    const handle = IV.dom.modal({
      title: term.title,
      body: h('div', { class: 'explain-body' }, term.body.map((p) => h('p', { text: p }))),
      footer: [h('button', { class: 'btn primary', text: 'Got it', onClick: () => handle.close() })]
    });
  }

  /**
   * A field label with the question mark beside it, which is where most of
   * these belong.
   */
  function label(text, key) {
    return h('span', { class: 'field-label with-help' }, h('span', { text }), badge(key));
  }

  /** A plain text link, for the few places a circle would look out of place. */
  function link(key, text) {
    const term = TERMS[key];
    if (!term) return null;
    return h('button', {
      type: 'button',
      class: 'help-link',
      text: text || term.title,
      onClick: () => open(key)
    });
  }

  IV.glossary = { badge, open, label, link, TERMS };
})(window.IV);
