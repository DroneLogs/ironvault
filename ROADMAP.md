# Roadmap to launch

Four stages, in order: **features → release → audit → send to creators.**
Nothing in a later stage starts until the one before it is done.

## Stage 1 — Features: what to add, fix, or remove

- [ ] **Word lists.** Nineteen ship as-is (EFF Large, EFF Short 1 & 2, the
  four EFF fandom lists, Diceware, Beale, names, Orchard Street, the
  Middle-earth list, the Icelandic list — attribution kept intact on the
  last three). Two get removed outright: SecureDrop (AGPL) and Google No
  Swears (blocks commercial use). The twelve language lists get traced to
  their original licence or dropped — that's a research task before this
  stage is done, not after.
- [ ] **YubiKey.** The `yubikey` branch forked at 1.3.0; main is five
  releases and a rename ahead of it, 56 files diverged. Rebase it onto
  current main, then get it in front of real hardware — the existing code
  has never touched an actual YubiKey. Ship it as a finished feature, not
  another untested beta.
- [ ] **Tier gate.** Every feature is on in one build right now. Build the
  actual free/Pro split from TIERS.md into the code, so the public repo can
  hold the free-tier source without giving Pro away.
- [ ] **Repo split.** `propolis` (public), `propolis-pro`, `dev-propolis`,
  `dev-propolis-pro` (the two removed word lists and the unresolved language
  lists live here, never in a shipped build).
- [ ] **Licensing.** Open source stated as such in the LICENSE file, not
  "source available."
- [ ] Rebrand cleanup: Skepwright as maker, Propolis as product, consistent
  everywhere.

## Stage 2 — Release

- [ ] Public 1.0.0 on the `propolis` repo, once everything in Stage 1 is in
  it. Release note written for a nontechnical reader, same voice as the
  rewritten notes.
- [ ] Microsoft Store submission — payment, signing, distribution and
  updates in one motion, worth doing at or right after launch rather than
  waiting.

## Stage 3 — Audit

- [ ] Apply to OSTIF once the public repo has some real activity behind it.
  Fallback: $4,000–$10,000 direct engagement if OSTIF doesn't pan out.
- [ ] Published in full, named auditor, dated — the way KeePassXC's was.
  That specifically is what got it onto Techlore's list; a claim without the
  document doesn't count.

## Stage 4 — Send to creators

- [ ] Build the creator download: full Pro access, labelled as a review
  copy, same code as a normal Pro licence, just provisioned free.
- [ ] Send to Techlore and All Things Secured with a link to the published
  audit. Worth knowing going in: Techlore and Privacy Guides both dropped
  Strongbox recently over misrepresenting how open its source really was —
  nothing here should rhyme with that.

## Later, not blocking any of the above

- [ ] Hosted sync as a paid add-on (existing WebDAV/SFTP code, a cheap VPS,
  zero-knowledge by construction).
- [ ] Vault sharing between users — separate, larger feature than sync, real
  multi-user access control.
- [ ] Signed installer outside the Store, once a certificate is affordable.
- [ ] Price Pro just under Bitwarden Premium (~$1.65/mo).

Accessibility is already done and free in every tier — no line item needed,
just worth mentioning to reviewers.
