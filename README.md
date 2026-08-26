# Ironvault

A KeePass password manager for Windows, built to work the way Strongbox does on iPhone:
pick a database, unlock it, browse groups, tap to reveal or copy, and it saves itself.

It reads and writes ordinary `.kdbx` files, so the same database works in Strongbox,
KeePassXC, KeePass, KeePassium, and anything else that speaks the format. Nothing is
uploaded anywhere and the app makes no network requests at all.

![Ironvault](build/icon.png)

## What it does

**Databases**
- Opens KDBX 3.1 and KDBX 4 files (AES-256 or ChaCha20; Argon2d, Argon2id, or AES-KDF)
- Creates new databases in either format
- Unlocks with a master password, a key file, or both
- Quick unlock: optionally remember the master password for one Windows account, encrypted
  with DPAPI through Electron's `safeStorage`
- Saves through a temporary file and a rename, and keeps a `.bak` of the previous contents
- Change the master key at any time

**Entries**
- Groups tree with nested sub groups, plus smart lists for all entries, favorites, recently
  changed, one time codes, expired, and the recycle bin
- Full text search across titles, usernames, URLs, notes, tags, and unprotected custom fields
- Entry detail with reveal, copy, and open in browser
- Custom fields, including protected ones that stay encrypted until you ask for them
- File attachments: add, save out, remove
- Per entry history, with a view and a restore for every earlier version
- Tags, favorites, expiry dates, duplicate, move between groups
- Recycle bin with restore and permanent delete

**One time codes**
- Reads `otp` fields holding `otpauth://` URIs (KeePassXC, Strongbox), KeeOTP query strings,
  and Tray TOTP's `TOTP Seed` / `TOTP Settings` pair
- SHA-1, SHA-256, and SHA-512, 6 to 8 digits, any period
- Live countdown ring and one click copy

**Password generator**

Two algorithms, with the output tinted by character type so you can read a password aloud
without squinting: uppercase, lowercase, digits, symbols, and Latin-1 each get their own
colour.

*Basic* builds a random string.
- Length 6 to 128
- Character groups: uppercase, lowercase, numeric, symbols, and Latin-1 supplement
- Easy Read Characters Only, which drops lookalikes (`0 1 2 5 l I O S Z ; : , . [ ] ( ) { } ! |`)
- Non-Ambiguous Characters Only, which drops `{ } [ ] ( ) / \ ' " ` and friends
- Pick Characters From Every Group, so at least one character comes from each group you ticked
- A free text box of characters to exclude outright

*Diceware* builds a passphrase from a word list.
- 1 to 16 words, any separator
- 26 word lists in three groups (see below), EFF Large by default
- Casing: do not change, lowercase, UPPERCASE, Title Case, or rAnDoM
- Add a number, an uppercase letter, a lowercase letter, a symbol, or a Latin-1 character
- Leetspeak in four strengths: basic or pro, some words or all words
- Salt as a prefix, a suffix, or sprinkled through the phrase

Both report strength the way Strongbox does, for example
`Strong (22 / 131.1 bits / >100m years)`: character count, entropy in bits, and how long an
offline attacker running a billion guesses a second would need. Categories are Very Weak,
Weak, Mediocre, Strong, Very Strong, and Overkill. Generated passwords report the entropy
the generator actually spent rather than an estimate, and mixing word lists or adding
characters is accounted for honestly.

**Username suggestions**
- Five shapes at a time: `joseph.mehlhaff`, `Lisbeth Pavlosky`, `Giovanna`,
  `sue353@comcast.net`, and a single random word like `clinic`
- Reachable from the dice button beside the Username field

**Tags**
- Tags are chips you add with Enter and remove with a click, with suggestions drawn from
  the tags already in the database

**Security audit**
- Weak passwords, reused passwords, entries with no password, expired entries, and anything
  not changed in over two years

**Safety**
- Clipboard clears itself after a configurable delay, and only if the value it wrote is
  still there
- Auto lock on idle, on sleep, on the Windows lock screen, and optionally on minimise
- Passwords are decrypted only for the field you asked for, one at a time

## Where Ironvault stands against Strongbox

Everything here is unlocked. There is no Pro tier and no paywall.

| Strongbox feature | Ironvault |
| --- | --- |
| Face ID / Touch ID Unlock | Windows Hello, done |
| Pin Code Unlock | done |
| Duress PIN, open decoy database | done |
| Duress PIN, delete all data | done |
| App Lock, delete after failed attempts | done |
| Compare Databases | done |
| Advanced Sync & Merge | done |
| Have I Been Pwned? Audit | done |
| Find Similar Audit | done |
| Audit (Find Weaknesses) | done |
| Favicon Downloader | done |
| SSH Agent | done |
| SFTP (Native Support) | done |
| WebDAV (Native Support) | done |
| Nextcloud / Owncloud (via WebDAV) | done |
| Offline Editing and Offline Viewing | done |
| Read Only Mode | done |
| Markdown Notes | done |
| Field References & Placeholders | done |
| Rolling Local Backups | done |
| Import & Export (1Password & CSV) | done, plus KeePass XML |
| Move Items between Databases | done, copy to another file |
| Auto Clear Clipboard | done |
| Regular Master Password Reminders | done |
| TOTP (QR Code, RFC 6238, Steam) | done |
| Diceware Passwords | done, 26 word lists |
| Configurable Password Generation | done |
| Custom Icons & Preset Icon Sets | custom icons, done |
| Custom App Icons | done |
| Powerful Search (All Fields) | done |
| Entry History | done |
| Attachments & Custom Fields | done |
| Custom Order & Sorting | done |
| Tags | done |
| Key File Support | done |
| Argon2 KDF (GPU Resistant) | done |
| Handle Large Databases | done |
| Custom URL Handling | done, `ironvault://` |
| AutoFill | Auto-Type, done |
| YubiKey (KeePass only) | not yet, needs USB HID access |
| Passkeys | stored and shown, cannot be used to sign in yet |
| OneDrive, Google Drive, Dropbox, Sharepoint | not yet, needs each provider's OAuth |
| Premium Support | not applicable |
| Apple Watch | not applicable on Windows |
| AirDrop Import/Export | not applicable on Windows |

### The three gaps, honestly

**YubiKey** needs raw USB HID access for the HMAC-SHA1 challenge, which means a native
module and a compiler on every machine that builds this. Everything else here is pure
JavaScript. It is doable, it is just a different kind of dependency.

**Passkeys** are stored, displayed, and survive a round trip, because they are just fields
in the KDBX file. Actually signing in with one needs a browser extension talking WebAuthn,
which is a separate program.

**OneDrive, Google Drive, Dropbox, and SharePoint** each need their own OAuth app
registration, review, and secret. WebDAV and SFTP cover self-hosted storage today, and all
four of those services sync a local folder anyway, so pointing Ironvault at the synced copy
already works.

## Word lists

26 lists, downloaded from their canonical sources by `npm run wordlists` and checked into
`wordlists/`. Full attribution and per list counts are in
[wordlists/SOURCES.md](wordlists/SOURCES.md).

- **Standard**: Beale, Diceware (Reinhold's original), EFF Large, EFF Short v1, EFF Short
  v2, Google (U.S. English, no swears), Orchard Street, SecureDrop
- **Fandom**: Game of Thrones, Harry Potter, Star Trek, Star Wars, all four from the EFF's
  2018 fan wikia lists
- **Languages**: Catalan, Dutch, Finnish, French, German, Icelandic, Italian, Japanese,
  Norwegian, Polish, Portuguese (Brazilian), Swedish

Two notes on honesty. The EFF fandom lists ship 8,000 numbered slots but only 4,000 unique
words, each listed twice, so Ironvault samples the 4,000 unique words and reports 11.97 bits
per word rather than the 12.97 the numbering implies. And no published Icelandic diceware
list exists, so that one is derived from a real Icelandic corpus using the usual rules
(lower case, letters only, four to eight characters, unique four character prefix), which is
reproducible and documented in the fetch script.

## Updates

Ironvault can check for new versions and install them, the way KeePass does on Windows. It
is off until you point it somewhere, and with no URL set it never touches the network.

To publish an update:

1. Bump `version` in `package.json` and run `npm run dist`.
2. Upload `Ironvault-Setup-X.Y.Z.exe`, `latest.yml`, and the `.blockmap` file from `dist/`
   to wherever you host them.
3. In Ironvault, open **Settings > Updates** and set the feed URL to the folder holding
   those files.

A GitHub release works with no server of your own. Attach the three files to a release and
use `https://github.com/USER/REPO/releases/latest/download/` as the feed URL. The repository
has to be public for this, since the app sends no credentials.

Installed copies then check on launch (if you leave that on), tell you what version is
available, download on your say so, and install on restart. The portable build cannot
replace itself, so it reports the new version and leaves the download to you.

## Install

Download and run one of the two builds in `dist/`:

- `Ironvault-Setup-1.0.0.exe` installs to your user profile and adds Start menu and
  desktop shortcuts. No administrator rights needed.
- `Ironvault-1.0.0-portable.exe` runs straight from the file, including from a USB stick.

Neither build is code signed, so SmartScreen will show "Windows protected your PC" the
first time. Choose **More info** then **Run anyway**.

Ironvault does not take over the `.kdbx` file association. If you want double clicking a
database to open it here, right click a `.kdbx` file, choose **Open with > Choose another
app**, and pick Ironvault.

## Keyboard shortcuts

| | |
| --- | --- |
| Search | `Ctrl F` |
| New entry | `Ctrl N` |
| New group | `Ctrl G` |
| Edit selected entry | `Ctrl E` |
| Copy username | `Ctrl B` |
| Copy password | `Ctrl Shift C` |
| Copy one time code | `Ctrl T` |
| Open URL | `Ctrl Shift U` |
| Password generator | `Ctrl P` |
| Security audit | `Ctrl Shift A` |
| Save | `Ctrl S` |
| Lock | `Ctrl L` |
| Settings | `Ctrl ,` |
| Delete selected entry | `Delete` |
| Move through the list | `↑` `↓` |

## Building it yourself

```
npm install
npm test          # 91 checks against the KDBX, generator, and strength layers
npm run dev       # run the app with dev tools enabled
npm run icon      # regenerate build/icon.ico and build/icon.png
npm run wordlists # re-download every word list from its source
npm run shots     # drive the real UI and write PNGs of every screen
npm run dist      # build the installer and the portable exe into dist/
```

`npm run dist` needs to extract electron-builder's `winCodeSign` bundle, which contains two
macOS symlinks. Windows refuses to create those without Developer Mode or an elevated
prompt. If the build stops with "Cannot create symbolic link", extract the cached archive by
hand once and the build will reuse it:

```
node_modules/7zip-bin/win/x64/7za.exe x -bd -y "%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0.7z" -o"%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0"
```

## How it is put together

```
src/main/       Electron main process: the only place that touches files or crypto
  argon2.js     registers a WASM Argon2 with kdbxweb so KDBX 4 opens at all
  vault.js      every database operation, and the only holder of the decrypted database
  totp.js       one time code parsing and generation
  strength.js   password strength, categories, and crack time
  generator.js  basic and diceware generation, and username suggestions
  wordlists.js  word list catalogue and loader
  updater.js    update checking, downloading, and installing
  settings.js   preferences and the recent database list, in %APPDATA%\ironvault
  ipc.js        the fixed list of operations the window is allowed to ask for
  main.js       window, menu, auto lock
src/preload/    the contextBridge, exposing exactly one call() and one on()
src/renderer/   the window: plain HTML, CSS, and scripts, no framework
wordlists/      the word lists themselves, plus a manifest and attribution
scripts/        self test, screenshot harness, icon and word list generators
```

The renderer runs sandboxed with context isolation on, node integration off, and a content
security policy that blocks every network scheme. It never receives a password unless it
asks for that one field by name, and it cannot reach the filesystem or the KDBX library at
all. Entry text is always written to the DOM through `textContent`, so a title containing
markup is just a title containing markup.

## Licence

MIT. Uses [kdbxweb](https://github.com/keeweb/kdbxweb) for the KDBX format,
[hash-wasm](https://github.com/Daninet/hash-wasm) for Argon2, and
[electron-updater](https://github.com/electron-userland/electron-builder) for updates.

The word lists keep their own licences, listed in
[wordlists/SOURCES.md](wordlists/SOURCES.md). The generator's behaviour, the character sets,
and the strength summary format follow
[Strongbox](https://github.com/strongbox-password-safe/Strongbox) so that a password made
here matches one made on the phone; the implementation is original.
