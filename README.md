# Propolis

A KeePass password manager for Windows, built to work the way Strongbox does on iPhone.

It reads and writes ordinary `.kdbx` files, so the same database opens in Strongbox,
KeePassXC, KeePass, and anything else that speaks the format. Nothing is uploaded anywhere,
and the only features that touch the network are ones you ask for.

![Propolis](build/icon.png)

## Download

| | |
| --- | --- |
| **Installer** | [latest release](https://github.com/DroneLogs/ironvault/releases/latest) |
| **Portable** | [latest release](https://github.com/DroneLogs/ironvault/releases/latest) |
| **All releases** | https://github.com/DroneLogs/ironvault/releases |

The installer adds Start menu and desktop shortcuts and needs no administrator rights. The
portable build runs straight from the file, including off a USB stick, and installs nothing.

### Beta builds

Betas are published as pre-releases, separate from the download above. Install one only if
you want to try something early, and back up your database first.

| | |
| --- | --- |
| **All betas** | [pre-releases](https://github.com/DroneLogs/ironvault/releases) |
| **YubiKey** | [`yubikey` branch](https://github.com/DroneLogs/ironvault/tree/yubikey), tagged `-beta` |

### Windows will warn you

The builds are not code signed yet, so SmartScreen shows "Windows protected your PC". Click
**More info**, then **Run anyway**. The warning is about the build being unsigned, not about
anything found in it.

## Features

**Databases**
- KDBX 3.1 and KDBX 4, AES-256 or ChaCha20, Argon2 or AES-KDF
- Unlock with a master password, a key file, or both
- Generates a memorable master password for you when you create a database
- Windows Hello unlock, PIN unlock, and quick unlock
- Duress PIN that opens a decoy database or wipes this one
- Delete everything after a set number of failed unlocks
- Read only mode
- Rolling local backups, and restore from any of them

**Entries**
- Item types: Login, Password, Secure note, Card, Identity and Email alias, each with the fields
  it needs and the built in ones named for it. A type is a marker in a custom field, so a card
  opened in another KeePass client is still an entry with sensible fields
- Groups, tags, favourites, attachments, custom fields, expiry dates
- Full text search across every field
- Per entry history, with view and restore
- Recycle bin with restore and permanent delete
- One time codes, Steam included, with a QR code to move them elsewhere
- Passkeys stored and shown
- Field references and placeholders such as `{USERNAME}` and `{REF:P@T:GitHub}`
- Markdown notes

**Password generator**
- Basic and Diceware, with the output tinted by character type
- 26 word lists in three groups: standard, fandom, and twelve languages, and any number of
  them at once. Words are drawn from the combined pool and the entropy follows its real size,
  so mixing Harry Potter into EFF Large buys the bits it looks like it buys
- Length, character groups, lookalike and ambiguous filtering, excluded characters
- Casing, leetspeak, salt, and added characters for passphrases
- Strength shown as `Strong (22 / 131.1 bits / >100m years)`
- Username suggestions in five shapes

**Checking your passwords**
- Weak, reused, empty, expired, and anything not changed in over two years
- Have I Been Pwned, which never sends your password
- Find similar, which catches `Summer2023` sitting next to `Summer2024`

**Getting data in and out**
- Import from CSV, KeePass XML, and 1Password `.1pux`
- Export to CSV or KeePass XML
- Compare two databases field by field, then merge
- Copy entries into another database

**Desktop and sync**
- Auto-type into whatever window is in front, on a global hotkey
- An SSH agent serving keys kept in the database
- WebDAV and SFTP sync, with offline editing and merge
- Favicon downloader
- `propolis://` links
- Update checking, pointed at this repository

**Accessibility**
- Four palettes: Blue CB (default), Blue, Amber CB and Amber. The CB pair swaps out
  the colours that merge under colour blindness
- Nothing depends on colour alone: strength meters fill a count of blocks, character colours
  are labelled, comparisons are marked with a minus and a plus
- Screen reader support, and every list operable from the keyboard
- OpenDyslexic and Atkinson Hyperlegible, bundled
- Scaling from 80 to 200 percent, larger click targets, high contrast, reduced motion, and a
  thicker focus outline

**Safety**
- The clipboard clears itself, and only if what it wrote is still there
- Auto lock on idle, on sleep, and on the Windows lock screen
- Passwords are decrypted one field at a time, only when asked for

Not sure what something means? Anything marked **?** explains itself in the app.

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
| Auto-type into the front window | `Ctrl Alt A`, anywhere in Windows |
| Password generator | `Ctrl P` |
| Security audit | `Ctrl Shift A` |
| Sync now | `Ctrl Shift S` |
| New database | `Ctrl Shift N` |
| Open database | `Ctrl O` |
| Save | `Ctrl S` |
| Lock | `Ctrl L` |
| Settings | `Ctrl ,` |
| Delete selected entry | `Delete` |
| Move through the list | `↑` `↓` |
| Close a dialog | `Esc` |

## Building it

```
npm install
npm test          # checks the KDBX, generator, and strength layers
npm start         # run it
npm run dist      # build the installer and portable exe into dist/
```

## Version numbers

Three parts, and each one answers a different question.

| Part | Bumped when | Examples |
| --- | --- | --- |
| **X** | KeePass itself moves and this has to follow | a new KDBX format version |
| **Y** | a new capability arrives | YubiKey unlock, passkeys that sign you in |
| **Z** | fixes and small additions | a palette, a help badge, spacing, an icon |

The number lives in one place, `version` in `package.json`. Everything else follows from
it: the installer and portable file names, the version Windows shows on the executable, and
what the updater compares against the release feed. Set it, commit it, then tag `vX.Y.Z`.

## Licence

MIT, with the exceptions set out in [LICENSING.md](LICENSING.md). Third party notices are in
[NOTICE.md](NOTICE.md), and the word lists with their licences in
[wordlists/SOURCES.md](wordlists/SOURCES.md).
