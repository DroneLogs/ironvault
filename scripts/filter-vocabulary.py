#!/usr/bin/env python3
"""Turns raw extracted vocabulary into a usable word list.

Feeds on what words-from-text.py produces and does four things to it.

Multi word names become one token joined by dots, so Minas Tirith is
minas.tirith and Gandalf the Grey is gandalf.the.grey. A passphrase needs each
draw to be a single thing you can type.

The parts of a name are kept as well as the whole, so bilbo.baggins also yields
bilbo and baggins. One name pays for three entries and the list grows without
anything being invented.

Sentence fragments are trimmed back to the name inside them. The extractor
cannot tell a chapter heading from a name, so "Concerning Pipe Weed" arrives
looking like a place. Leading and trailing function words are stripped, which
turns it into pipe.weed, "Come Tom Bombadil" into tom.bombadil and "Suddenly
Gandalf" into gandalf. Only function words are stripped, never ordinary nouns,
or Bay of Balar would collapse to balar.

Ordinary English is removed from the single words, because it is already
available in every other list in the app and adds nothing here. A word only
survives on its own if it is not in the English reference lists. It can still
appear inside a name: the "the" in gandalf.the.grey stays, because there it is
part of a thing rather than a word in its own right.

  python scripts/filter-vocabulary.py corpus/tolkien.names.txt corpus/tolkien.words.txt
"""

import argparse
import re
import sys
import unicodedata
import urllib.request
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace") if hasattr(sys.stdout, "reconfigure") else None

WORDLISTS = Path(__file__).resolve().parent.parent / "wordlists"

# The lists already shipping in the app that are ordinary English. A word in one
# of these is not worth a slot here, because a passphrase can draw it from there.
ENGLISH_LISTS = [
    "eff-large",
    "eff-short-1",
    "eff-short-2",
    "google-no-swears",
    "orchard-street",
    "securedrop",
    "beale",
    "diceware",
]

# Words that begin or end a sentence fragment rather than a name. Deliberately
# function words and narrative verbs only: prepositions, conjunctions, adverbs,
# pronouns, and the verbs prose leans on. Ordinary nouns are not here, because
# Bay of Balar, Citadel of Gondor and Tower of the Setting Sun all open with one.
EDGE_WORDS = set(
    """
    a an the and but or nor for yet so if then than that this these those there here
    of in on at to from by with without within into onto upon over under above below
    across around through throughout beyond behind before after against among amongst
    amid amidst beside besides between beneath near toward towards until till since
    while when where whence whither why how what which who whom whose
    i me my mine you your yours he him his she her hers it its we us our ours they them their theirs
    is am are was were be been being do does did done have has had having
    shall should will would can could may might must let
    not no nor none never ever always often sometimes now soon still yet again once
    very much many more most less least some any all both each every other another same
    said says say tell told speak spoke spoken cry cried call called name named
    come came go went gone going take took taken give gave given get got make made
    see saw seen look looked hear heard know knew known think thought seem seemed
    turn turned stand stood sit sat rise rose put set lay laid
    indeed perhaps surely truly certainly suddenly presently meanwhile therefore thus
    also even just only quite rather almost nearly about concerning regarding
    yes nay lo behold alas well ah oh
    long last first next final other new old great small good bad
    wish hope fear seek find found sought
    actually finally immediately quickly slowly softly suddenly evidently apparently
    nevertheless however moreover anyway further furthermore likewise accordingly
    hereafter henceforth afterwards presently swiftly slowly gently loudly
    """.split()
)

# The books arrive with their own front and back matter, and a publisher is not
# a place in Middle-earth. Any phrase mentioning one of these is dropped whole.
PUBLISHING = set(
    """
    ace ballantine houghton mifflin allen unwin harper collins tolkien christopher
    isbn copyright reprinted printing edition foreword preface publisher published
    press books book paperback hardback illustrated jacket cover blurb
    """.split()
)

# What a token has to look like once it is finished.
TOKEN = re.compile(r"^[a-z]+(?:\.[a-z]+)*$")


def fold(text):
    """Lowercase plain ASCII, with typography flattened."""
    for fancy, plain in {
        "‘": "", "’": "", "‚": "", "‛": "",
        "“": "", "”": "", "ı": "i", "İ": "i",
        "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-",
    }.items():
        text = text.replace(fancy, plain)
    text = "".join(c for c in unicodedata.normalize("NFD", text) if not unicodedata.combining(c))
    return unicodedata.normalize("NFC", text).lower()


# The app's own lists hold about 22,000 common words, which sounds like plenty
# and is not. They carry no inflections, so pushes, roamed, nobly and
# manuscripts all survive a filter built on them and the result reads like a
# thesaurus rather than a Tolkien list. This is a real dictionary, 370,000
# words, fetched once and cached beside the corpus.
DICTIONARY_URL = "https://raw.githubusercontent.com/dwyl/english-words/master/words_alpha.txt"


def big_dictionary(cache):
    """A comprehensive English dictionary, downloaded once and kept."""
    if not cache.is_file():
        print("fetching an English dictionary, once, to " + str(cache))
        request = urllib.request.Request(
            DICTIONARY_URL, headers={"User-Agent": "propolis-wordlist-builder"}
        )
        with urllib.request.urlopen(request, timeout=120) as response:
            cache.write_bytes(response.read())
    return {
        line.strip().lower()
        for line in cache.read_text(encoding="utf-8", errors="replace").splitlines()
        if line.strip()
    }


# Even 370,000 words misses forms, so anything that reduces to a known word by
# shedding an ordinary ending is ordinary too.
SUFFIXES = ("s", "es", "ed", "d", "ing", "ly", "er", "est", "ness", "less", "ful")


def is_ordinary(word, english):
    if word in english:
        return True
    for suffix in SUFFIXES:
        if not word.endswith(suffix) or len(word) - len(suffix) < 3:
            continue
        stem = word[: -len(suffix)]
        if stem in english or (stem + "e") in english:
            return True
        # cosily from cosy, happily from happy
        if stem.endswith("i") and (stem[:-1] + "y") in english:
            return True
        # stopped from stop, running from run
        if len(stem) > 3 and stem[-1] == stem[-2] and stem[:-1] in english:
            return True
    return False


def english_reference(cache):
    """Two tiers, because a name and a word deserve different tests.

    Common is the app's own lists, about 22,000 everyday words. Full adds an
    unabridged dictionary of 370,000.

    A word met as a name is judged against Common only. Bilbo is in the
    unabridged dictionary, because a bilbo is a kind of sword, and judging it
    against that would throw away the most famous name in the books. A
    capitalised word that is also an everyday word, King or Grey or Tower, is
    being used as a title or a common noun and does go.

    A word met as ordinary vocabulary is judged against Full, which is what
    clears out roamed, nobly and manuscripts and leaves mithril and palantir.
    """
    words = set()
    for key in ENGLISH_LISTS:
        path = WORDLISTS / (key + ".txt")
        if not path.is_file():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            word = line.strip().lower()
            if word:
                words.add(word)
    common = set(words)
    try:
        words |= big_dictionary(cache)
    except Exception as err:
        print("  could not fetch the dictionary (" + str(err) + "), using the app lists only")
    return common, words


def pieces(name):
    """Splits a name into its parts, flattening apostrophes and hyphens."""
    plain = fold(name).replace("-", " ")
    return [p for p in re.split(r"[^a-z]+", plain) if p]


def trim_edges(parts):
    """Cuts the sentence away from the name at either end."""
    start, end = 0, len(parts)
    while start < end and parts[start] in EDGE_WORDS:
        start += 1
    while end > start and parts[end - 1] in EDGE_WORDS:
        end -= 1
    return parts[start:end]


def main():
    parser = argparse.ArgumentParser(description="Filter extracted vocabulary into a word list.")
    parser.add_argument("names", type=Path)
    parser.add_argument("words", type=Path)
    parser.add_argument("--out", type=Path, default=None)
    parser.add_argument("--min", type=int, default=3, dest="min_len")
    parser.add_argument("--max", type=int, default=14, dest="max_len")
    args = parser.parse_args()

    common, english = english_reference(args.names.parent / "english-words.txt")
    print("everyday English: {:,} words | full dictionary: {:,}".format(len(common), len(english)))

    raw_names = [l.strip() for l in args.names.read_text(encoding="utf-8").splitlines() if l.strip()]
    raw_words = [l.strip() for l in args.words.read_text(encoding="utf-8").splitlines() if l.strip()]

    phrases, singles = {}, {}
    trimmed_count = 0

    def keep_single(word, source):
        if not (args.min_len <= len(word) <= args.max_len):
            return
        if not TOKEN.match(word):
            return
        if word in EDGE_WORDS:
            return
        # A name is only weighed against everyday English, a plain word against
        # the whole dictionary. See english_reference for why.
        if source == "name":
            if is_ordinary(word, common):
                return
        elif is_ordinary(word, english):
            return
        singles.setdefault(word, source)

    for name in raw_names:
        parts = pieces(name)
        if not parts:
            continue
        cut = trim_edges(parts)
        if len(cut) != len(parts):
            trimmed_count += 1
        if not cut:
            continue

        # A word repeating inside a phrase means a glossary run rather than a
        # name: angband.iron.prison.hell.of.iron is a dictionary entry with its
        # translation attached, not something anybody calls a place.
        # A publisher, a copyright line or the author himself is not Middle-earth.
        if any(p in PUBLISHING for p in cut):
            for part in cut:
                if part not in PUBLISHING:
                    keep_single(part, "name")
            continue

        meaningful = [p for p in cut if p not in EDGE_WORDS]
        if len(meaningful) != len(set(meaningful)):
            for part in cut:
                keep_single(part, "name")
            continue

        if len(cut) > 1:
            token = ".".join(cut)
            if TOKEN.match(token) and args.min_len <= len(token) <= 32 and all(len(p) >= 2 for p in cut):
                phrases.setdefault(token, name)
            # Each part earns its own place, if it is not ordinary English.
            for part in cut:
                keep_single(part, "name")
        else:
            keep_single(cut[0], "name")

    for word in raw_words:
        plain = fold(word)
        if not plain.isalpha():
            continue
        keep_single(plain, "word")

    out = args.out or args.names.parent / "tolkien.list.txt"
    final = sorted(set(phrases) | set(singles))
    out.write_text("\n".join(final) + "\n", encoding="utf-8")

    bits = __import__("math").log2(len(final)) if final else 0
    print("  phrases kept:        {:,}".format(len(phrases)))
    print("  single words kept:   {:,}".format(len(singles)))
    print("  names trimmed back:  {:,}".format(trimmed_count))
    print("  total:               {:,}  ({:.2f} bits per word)".format(len(final), bits))
    print("\nwrote " + str(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
