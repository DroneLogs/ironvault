# Third party notices

Ironvault is MIT licensed. It bundles the following, each under its own licence.

## Code

- **Electron** — MIT — https://github.com/electron/electron
- **kdbxweb** — MIT — https://github.com/keeweb/kdbxweb
- **hash-wasm** — MIT — https://github.com/Daninet/hash-wasm
- **electron-builder / electron-updater** — MIT — https://github.com/electron-userland/electron-builder
- **ssh2** — MIT — https://github.com/mscdex/ssh2
- **qrcode** — MIT — https://github.com/soldair/node-qrcode

## Word lists

Full per list detail, including counts and source URLs, is in
[wordlists/SOURCES.md](wordlists/SOURCES.md).

- **EFF Large, EFF Short v1.0, EFF Short v2.0** and the four **EFF fandom lists**
  (Game of Thrones, Harry Potter, Star Trek, Star Wars) — Creative Commons Attribution
  3.0 United States, © Electronic Frontier Foundation. Trademarks appearing in the fandom
  lists belong to their respective holders, who are not affiliated with and do not endorse
  the EFF or this software.
- **Diceware (original)** — CC BY 3.0, © Arnold G. Reinhold.
- **Beale** — distributed with Diceware, © Alan Beale.
- **Orchard Street** — CC BY-SA 4.0, © Sam Schlinkert.
- **SecureDrop** — AGPL-3.0, © Freedom of the Press Foundation. Not suitable for closed
  source commercial redistribution.
- **Google (U.S. English, No Swears)** — derived from the Google Trillion Word Corpus via
  first20hours/google-10000-english. Its licence permits educational and personal use and
  advises against commercial use without a Linguistic Data Consortium licence.
- **Language lists** (Catalan, Dutch, Finnish, French, German, Italian, Japanese, Norwegian,
  Polish, Portuguese, Swedish) — the classic Diceware translations, collected in
  atoponce/webpassgen. Individual authorship varies.
- **Icelandic** — generated from the Icelandic corpus in hrafnthor/diceware-is, itself drawn
  from BÍN (CC BY-SA 4.0). This derived list is offered under CC BY-SA 4.0.
- **First names and surnames** — US Census Bureau, public domain, via
  dominictarr/random-name.

## Fonts

- **OpenDyslexic** by Abbie Gonzalez — SIL Open Font Licence 1.1
- **Atkinson Hyperlegible** by the Braille Institute of America — SIL Open Font Licence 1.1

Both permit bundling inside an application, commercial use included, as long as the licence
accompanies the font and the font is not sold on its own.

## Design reference

The password generator's options, character sets, and strength summary format follow
[Strongbox](https://github.com/strongbox-password-safe/Strongbox) (AGPL-3.0) so that a
password made in Ironvault matches one made in Strongbox. No Strongbox code was copied; the
implementation is original. See [LICENSING.md](LICENSING.md).
