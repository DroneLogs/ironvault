# What is free and what is Pro

The line is drawn from [Strongbox's own comparison table](https://strongboxsafe.com/comparison/).
The rule: **if Strongbox gives it away, Propolis gives it away.** If Strongbox charges for it,
so do we. Where a Propolis feature has no Strongbox equivalent it goes to Pro, with three
exceptions noted at the bottom.

Strongbox has separate tables for iOS and macOS. Propolis is a desktop app, so the macOS
table decides. Where a feature only appears on the iOS table, that row is used instead and
is marked *(iOS)*.

## Free

Everything needed to keep passwords in a file and use them every day.

| Propolis | Strongbox row |
| --- | --- |
| KDBX 3.1 and 4, AES-256 or ChaCha20, Argon2 or AES-KDF | Argon2 KDF (GPU Resistant) |
| Master password, key file, or both | Key File Support |
| A generated master password when you create a database | Diceware Passwords |
| Windows Hello unlock, PIN unlock, quick unlock | Touch ID Unlock, Pin Code Unlock *(iOS)* |
| Reminders to change your master password | Regular Master Password Reminders |
| Read only mode | Read Only Mode |
| Rolling local backups, and restore from any of them | Rolling Local Backups |
| Groups, tags, favourites, expiry dates | Tags, Custom Order & Sorting |
| Attachments and custom fields | Attachments, Custom Fields |
| Custom and preset entry icons | Custom Icons & Preset Icon Sets *(iOS)* |
| Full text search across every field | Powerful Search (All Fields) |
| Per entry history, with view and restore | Entry History |
| Recycle bin with restore and permanent delete | part of the basic vault |
| One time codes, Steam included, with QR | TOTP (QR Code, RFC 6238, Steam) *(iOS)* |
| Field references and placeholders | Field References & Placeholders |
| Markdown notes | Markdown Notes |
| The password generator, basic and Diceware, all options | Customizable Password Generation |
| The strength meter | part of generation |
| Username suggestions | part of generation |
| Compare two databases field by field | Compare Databases |
| Import and export CSV, and export KeePass XML | Import & Export (CSV, Encrypted) *(iOS)* |
| WebDAV and SFTP sync | WebDAV Sync, SFTP Sync |
| Editing and viewing while offline | Offline Editing, Offline Viewing |
| Auto-type into the window in front | AutoFill |
| `propolis://` links | Custom URL Handling |
| The clipboard clearing itself | Auto Clear Clipboard |
| Auto lock on idle, sleep and the lock screen | part of the basic vault |
| Update checking | free in both |

## Pro

| Propolis | Strongbox row |
| --- | --- |
| Security audit: weak, reused, empty, expired, and over two years old | Audit (Find Weaknesses) |
| Have I Been Pwned check | Have I Been Pwned? Audit |
| Find similar, which catches `Summer2023` beside `Summer2024` | Find Similar Audit |
| YubiKey unlock | YubiKey for KeePass |
| Passkey **storage**: a passkey saved elsewhere is read and shown | Passkeys, but only in part. Strongbox's row means signing in with one, which needs the browser extension and is not built. Do not claim parity on this line. |
| SSH agent serving keys from the database | SSH Agent |
| Favicon downloader | FavIcon Downloader |
| Sync merge, and reconciling offline edits | Advanced Sync & Merge |
| Import from 1Password `.1pux` | Import & Export (1Password & CSV) |
| Duress PIN opening a decoy database | Duress PIN - Open Dummy Database *(iOS)* |
| Duress PIN wiping the database | Duress PIN - Delete All Data *(iOS)* |
| Wipe after a set number of failed unlocks | App Lock (Delete All on Fails) *(iOS)* |
| Copying and moving entries into another database | Move Items between Databases *(iOS)* |
| Large database handling | Handle Large Databases (250MB+) *(iOS)* |
| **Item types**: Card, Identity, Secure note, Email alias | no equivalent, so Pro |
| **Word lists beyond the standard set**: the fandom lists | no equivalent, so Pro |

## Three carve-outs, made deliberately

**Accessibility stays free, all of it.** The colour blind palettes, the screen reader work,
OpenDyslexic and Atkinson Hyperlegible, the scaling, high contrast, reduced motion, larger
click targets. Strongbox's table has no accessibility row at all, so the rule above would
push every bit of it into Pro. Charging disabled users for a usable app is not a business
model, and in several places it is the kind of thing that attracts a lawyer. This is the one
rule I would not follow off a cliff.

**The four colour palettes stay free**, for the same reason. Strongbox charges for Custom App
Icons, and if these were decoration they would be Pro. Two of the four exist so the app is
readable if you are colour blind, and they change the icon as a side effect rather than as
the point.

**The explanations behind every `?` stay free.** No Strongbox equivalent. Gating the thing
that explains what a key file is, for someone deciding whether they need one, is backwards.

## Dev Propolis Pro only

Not a tier. These cannot ship in a paid, closed build at all, so they stay in the private
development repository and come out of any build that gets sold.

| What | Why |
| --- | --- |
| Google (U.S. English, No Swears) word list | Its licence permits educational and personal use and points at the Linguistic Data Consortium for anything commercial. Using it in a paid build means buying a licence. |
| SecureDrop word list | AGPL-3.0. Distributing it obliges us to publish the complete source of whatever ships with it, which a paid closed build cannot do. |
| The twelve language word lists | Fetched from a repository that is AGPL-3.0. The lists are older translations that probably are not covered by it, but "probably" is not a position to sell from. They come back once each is traced to its original author. |
| The Tolkien book word list | Built from the text of books still in copyright. Never committed to any repository and not in the app. |

The Middle-earth wiki list is **not** in this table. It is CC BY-SA, which binds the list to
those terms and requires attribution, but costs nothing and does not make the app copyleft.
It ships in Pro with its attribution intact.

## What still has to be built

This document is the decision, not the implementation. The code currently has no notion of a
tier: every feature above is present and switched on in one build. Splitting it means a
licence check and a gate on each Pro feature, and until that exists the public repository
cannot receive the full source without giving the paid tier away.
