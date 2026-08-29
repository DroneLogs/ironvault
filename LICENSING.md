# Licensing: can Propolis be sold?

You asked whether the features here could sit behind a paywall once you had looked at the
KeePass copyright. Short answer: **KeePass is not the problem. Two of the word lists are.**

I am not a lawyer and this is not legal advice. What follows is what the licences actually
say, checked against each project's own licence file, so you know where to look.

## KeePass itself: not an issue

KeePass is GPL-2.0, but **Propolis contains no KeePass code**. It reads and writes the
KDBX file format, and a file format is not a copyrightable work. That is why KeePassXC,
KeePassium, Strongbox, Bitwarden's importer, and the `kdbxweb` library this app uses all
implement KDBX independently, several of them commercially.

Nothing about selling Propolis runs into KeePass.

## The code: all clear

| Component | Licence | Sellable |
| --- | --- | --- |
| Electron | MIT | yes |
| kdbxweb (the KDBX implementation) | MIT | yes |
| hash-wasm (Argon2) | MIT | yes |
| electron-builder / electron-updater | MIT | yes |
| ssh2 (SFTP) | MIT | yes |
| qrcode | MIT | yes |

MIT permits commercial use and closed-source distribution, provided the licence text ships
with the app. That is what `NOTICE.md` is for.

## The word lists: two real problems

This is where the actual constraints are.

### Cannot ship in a paid, closed-source build

The **Middle-earth list** (`fandom-lotr`) is derived from a Fandom wiki and is therefore
CC BY-SA, not CC BY like the four EFF fandom lists. Share-alike attaches to the list, not
to this application: shipping it means carrying the attribution and keeping the list itself
under the same terms. It does not make the app copyleft, and it does not block a paid build
the way the AGPL and non-commercial lists below do. Tolkien names are not the issue here,
since individual words and names are not copyrightable; the wiki licence is.

**SecureDrop** (`wordlists/securedrop.txt`) comes from the SecureDrop repository, which is
**AGPL-3.0**. The AGPL requires that anything distributing the work also offers its complete
corresponding source. That is incompatible with a closed commercial build.

**Google (U.S. English, No Swears)** (`wordlists/google-no-swears.txt`) is worse, because
its own licence file says so in as many words: *educational and personal or research use is
permitted*, and it explicitly does not recommend commercial use without a licence from the
Linguistic Data Consortium. That is a direct statement against the use you are contemplating.

**If you go commercial, delete those two lists.** The fetch script makes that a one-line
change, and 24 lists remain.

### Fine commercially, with attribution

| List | Licence | Requirement |
| --- | --- | --- |
| EFF Large, EFF Short v1 and v2 | CC BY 3.0 US | credit the EFF |
| Game of Thrones, Harry Potter, Star Trek, Star Wars | CC BY 3.0 US | credit the EFF |
| Diceware (Reinhold's original) | CC BY 3.0 | credit Arnold G. Reinhold |
| Beale | distributed with Diceware, same terms | credit Alan Beale |
| First names and surnames | US Census, public domain | none |

One caution on the four fandom lists: they are freely licensed, but they are built from fan
wiki pages and contain trademarked names. The EFF's own note says the trademarks belong to
their holders, who neither sponsor nor endorse them. Shipping them is fine. Naming your
product after them, or advertising with them, is not.

### Share-alike, so read before shipping

**Orchard Street** is **CC BY-SA 4.0**, and the **Icelandic** list is derived from a corpus
that is also CC BY-SA. Share-alike attaches to derivatives *of the list*. Propolis ships
Orchard Street unmodified and only reads it, so the app is not a derivative of it, but the
list must stay under CC BY-SA with attribution wherever it goes. The Icelandic list is a
derivative I generated, so it must itself be offered under CC BY-SA.

### The eleven language lists: unclear, and worth a look

Catalan, Dutch, Finnish, French, German, Italian, Japanese, Norwegian, Polish, Portuguese,
and Swedish were fetched from **atoponce/webpassgen**, which is **AGPL-3.0**. The lists
themselves are the classic Diceware translations by various authors, not that project's
work, and data files bundled in an AGPL repo do not automatically become AGPL. But "probably
fine" is not a position to sell from. Before charging money, either trace each list to its
original author and licence, or drop the Languages category.

## Strongbox: the part I would actually ask a lawyer about

Propolis matches Strongbox feature for feature, and I read Strongbox's source to get the
details right: the character sets, the strength categories, the `Strong (22 / 131.1 bits /
>100m years)` summary format, the five username shapes.

**Strongbox is AGPL-3.0.** No Strongbox code was copied; every line here is original. In
US law, functionality, behaviour, and interfaces are generally not protected the way
expression is, which is the ground *Google v. Oracle* was decided on. That is the honest
legal position and it is a reasonable one.

It is also the position with the most money at stake if someone disagrees. If Propolis is
free, this is close to a non-issue. If you charge for it, and it is a feature-for-feature
Windows version of a paid AGPL app, that is worth an hour of a software lawyer's time before
you take a payment. I would not skip that step.

## What I would actually do

**Free, source available (today):** everything ships as is. Add attribution, which
`NOTICE.md` does. No conflicts. This is where the project stands now.

**If you want to sell it:**

1. Delete `securedrop` and `google-no-swears` from `scripts/fetch-wordlists.js` and from
   `wordlists/`.
2. Either trace the eleven language lists to their original licences, or drop them.
3. Keep the EFF and Diceware attribution visible in the app, not only in a file.
4. Ask a software lawyer about the Strongbox similarity. Bring this file.
5. Consider open sourcing under AGPL yourself and charging for something the licence does
   not touch: hosted sync, support, signed builds. That sidesteps every question above,
   and it is roughly what Strongbox does.

One more practical point: paid Windows software really wants a code signing certificate
(around 200 to 500 US dollars a year). Without one every download shows a SmartScreen
warning, which is survivable for friends testing a build and not survivable for customers.
