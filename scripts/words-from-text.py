#!/usr/bin/env python3
"""Pull the vocabulary out of a text file or a PDF, in the order it appears.

Written for building a word list from prose. Two things come out of it:

  names   multi word proper nouns, kept whole, so Minas Tirith stays Minas
          Tirith rather than becoming minas and tirith in separate places
  words   every distinct word, in first appearance order

First appearance order rather than alphabetical is deliberate. Alphabetical
throws away the one piece of context a flat list can carry: what turned up
near what. Reading down the file you pass through the story in order, and
related names sit together because they were introduced together.

Catching the multi word names is the harder half, and it needs two passes.
A capitalised word at the start of a sentence tells you nothing, since every
sentence starts that way. So the first pass collects the words that appear
capitalised in the *middle* of a sentence, which is real evidence of a proper
noun, and the second pass uses that evidence to read the sentence openings
correctly. Without it, The and But and He end up in your list of names.

  python scripts/words-from-text.py book.txt
  python scripts/words-from-text.py book.pdf
  python scripts/words-from-text.py *.txt --out-dir vocab --min 3 --max 12
  python scripts/words-from-text.py book.txt
  python scripts/words-from-text.py book.pdf --fold-accents --lower

The input is never modified and nothing is sent anywhere.
"""

import argparse
import re
import shutil
import subprocess
import sys
import unicodedata
from pathlib import Path

# A Windows console defaults to a code page that cannot print Éowyn, which
# makes correct output look broken. The files were always fine; this fixes
# what you see while it runs.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):
    pass

# A word may carry accents, an apostrophe or a hyphen: Eärendil, Helm's, Barad-dûr.
WORD = re.compile(r"[^\W\d_]+(?:['’\-][^\W\d_]+)*", re.UNICODE)

# End of sentence, so the next capital is structural rather than meaningful.
SENTENCE_END = re.compile(r"[.!?…]['\"’”)\]]*\s")

# Small words that sit inside a name without being capitalised themselves.
# Deliberately narrow. "and" is not here, and neither are "in", "at" or "on":
# they nearly always join two separate names rather than living inside one,
# and allowing them turned Helm's Deep and Éowyn into a single made up place.
CONNECTORS = {"of", "the", "de", "du", "von", "van"}

# Nobody wants these as the whole of a name, however they are capitalised.
NOT_A_NAME = {
    "the", "a", "an", "and", "but", "or", "if", "so", "then", "for", "yet",
    "he", "she", "it", "they", "we", "you", "i", "his", "her", "its", "their",
    "this", "that", "these", "those", "there", "here", "when", "while", "as",
    "at", "by", "in", "on", "to", "up", "out", "no", "not", "now", "all",
    "chapter", "book", "part", "volume", "appendix", "prologue", "epilogue",
}


def fold(text):
    """Strips accents, so Eärendil can be typed as Earendil."""
    return "".join(c for c in unicodedata.normalize("NFD", text) if not unicodedata.combining(c))


def read_pdf(path):
    """Text out of a PDF, by whichever route is available.

    pypdf if it is installed, otherwise poppler's pdftotext, which ships with
    Git for Windows and does a better job of reading order anyway. A PDF with
    no text layer is a picture of a book and neither route can help: that needs
    OCR, which is a different tool and a different afternoon.
    """
    try:
        import pypdf

        reader = pypdf.PdfReader(str(path))
        return "\f".join((page.extract_text() or "") for page in reader.pages)
    except ImportError:
        pass

    binary = shutil.which("pdftotext")
    if not binary:
        for guess in (
            r"C:\Program Files\Git\mingw64\bin\pdftotext.exe",
            r"C:\Program Files\Git\usr\bin\pdftotext.exe",
        ):
            if Path(guess).is_file():
                binary = guess
                break

    if not binary:
        raise RuntimeError(
            "reading a PDF needs either pypdf (pip install pypdf) or pdftotext, "
            "which comes with Git for Windows and poppler. Neither was found."
        )

    result = subprocess.run(
        [binary, "-q", "-enc", "UTF-8", str(path), "-"],
        capture_output=True,
    )
    return result.stdout.decode("utf-8", errors="replace")


def decode_text(raw):
    """Plain text arrives in whatever encoding it arrives in."""
    for encoding in ("utf-8-sig", "utf-8", "cp1252", "latin-1"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return None


def strip_running_heads(text):
    """Drops the lines a typeset book repeats on every page.

    A running head is the book's own title printed at the top of two hundred
    pages, and a naive read turns that into two hundred votes for whatever it
    says. Page numbers do the same. Anything appearing at the top or bottom of
    a page often enough is furniture rather than prose, so it goes.
    """
    pages = text.split("\f")
    if len(pages) < 4:
        return text

    edges = {}
    for page in pages:
        lines = [line.strip() for line in page.splitlines() if line.strip()]
        for line in lines[:2] + lines[-2:]:
            edges[line] = edges.get(line, 0) + 1

    threshold = max(3, len(pages) // 4)
    furniture = {line for line, count in edges.items() if count >= threshold}

    kept = []
    for page in pages:
        for line in page.splitlines():
            stripped = line.strip()
            if stripped in furniture:
                continue
            # A line that is only a number is a page number.
            if re.fullmatch(r"[ivxlcdm]+|\d+", stripped, re.IGNORECASE):
                continue
            kept.append(line)
    return "\n".join(kept)


def tidy(text):
    """Undoes what typesetting did to the words.

    Ligatures first, so ﬁ becomes fi rather than a character no word list
    wants. Then hyphenation: a book breaks Mor-dor across two lines, and read
    literally that is two words, neither of which is a word.
    """
    text = unicodedata.normalize("NFKC", text)
    text = re.sub(r"(\w)[-\u2010\u2011]\s*\n\s*(\w)", r"\1\2", text)
    return text


def read_any(path):
    """One file in, text out, whatever it happens to be."""
    if path.suffix.lower() == ".pdf":
        raw = read_pdf(path)
        # A PDF with no text layer is a picture of a book. It extracts to
        # nothing at all, and writing two empty files and calling it done
        # would be the least helpful possible outcome.
        if len("".join(raw.split())) < 200:
            raise RuntimeError(
                str(path)
                + " has no text layer, so there is nothing to read: it is a scan, "
                + "a picture of a page rather than the words on it. That needs OCR "
                + "first, with something like ocrmypdf, and this script can read the "
                + "result."
            )
        return tidy(strip_running_heads(raw))
    decoded = decode_text(path.read_bytes())
    if decoded is None:
        raise RuntimeError("could not decode " + str(path))
    return tidy(decoded)


def sentences(text):
    """Rough sentence split. It only has to be good enough to spot openings."""
    start = 0
    for match in SENTENCE_END.finditer(text):
        yield text[start:match.end()]
        start = match.end()
    if start < len(text):
        yield text[start:]


def is_capitalised(token):
    """Title case, which is what a name looks like.

    Deliberately not "starts with a capital", because a PDF hands you the title
    page and the chapter headings in capitals, and every word of GREENOUGH'S
    NEW LATIN GRAMMAR then reads as a proper noun. A word in capitals is
    typography rather than a name, so it is not evidence and cannot join a run.
    It is still counted as an ordinary word.
    """
    return token[:1].isupper() and not token.isupper()


def proper_noun_evidence(text):
    """Words seen capitalised anywhere but the first position of a sentence.

    That is the whole trick. A capital at a sentence opening is grammar; a
    capital in the middle of one is a name.
    """
    seen = set()
    for sentence in sentences(text):
        tokens = WORD.findall(sentence)
        for token in tokens[1:]:
            if is_capitalised(token):
                seen.add(token.lower())
    return seen


def names_and_words(text, evidence, min_len, max_len):
    """Walks the text once, emitting names and words as they first appear."""
    names, words = {}, {}

    def note(store, key, display):
        if key not in store:
            store[key] = display

    for sentence in sentences(text):
        tokens = WORD.findall(sentence)
        index = 0
        while index < len(tokens):
            token = tokens[index]
            lowered = token.lower()

            # A name has to be capitalised, and if it opens the sentence it has
            # to have been seen capitalised elsewhere to count.
            opens = index == 0
            proper = (
                is_capitalised(token)
                and lowered not in NOT_A_NAME
                and (not opens or lowered in evidence)
            )

            if proper:
                run = [token]
                look = index + 1
                while look < len(tokens):
                    nxt = tokens[look]
                    if is_capitalised(nxt) and nxt.lower() not in NOT_A_NAME:
                        run.append(nxt)
                        look += 1
                        continue
                    # Connectors count only when a capital follows them, and
                    # there can be more than one: Battle of the Pelennor Fields
                    # needs both "of" and "the". Aragorn of course does not.
                    span = look
                    while span < len(tokens) and tokens[span].lower() in CONNECTORS:
                        span += 1
                    if (
                        span > look
                        and span < len(tokens)
                        and is_capitalised(tokens[span])
                        and tokens[span].lower() not in NOT_A_NAME
                    ):
                        run.extend(tokens[look:span])
                        look = span
                        continue
                    break

                if len(run) > 1:
                    phrase = " ".join(run)
                    note(names, phrase.lower(), phrase)
                    index = look
                    # The parts are words in their own right as well.
                    for part in run:
                        if min_len <= len(part) <= max_len:
                            note(words, part.lower(), part)
                    continue

                if min_len <= len(token) <= max_len:
                    note(names, lowered, token)

            if min_len <= len(token) <= max_len:
                note(words, lowered, token)
            index += 1

    return names, words


def write(path, values, lower, folded):
    lines = []
    for value in values:
        text = fold(value) if folded else value
        lines.append(text.lower() if lower else text)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return len(lines)


def main():
    parser = argparse.ArgumentParser(description="Pull vocabulary out of prose, in order of appearance.")
    parser.add_argument("files", nargs="+", type=Path, help="one or more .txt or .pdf files")
    parser.add_argument("--out-dir", type=Path, default=None, help="where to write (default: beside the input)")
    parser.add_argument("--min", type=int, default=2, dest="min_len", help="shortest word to keep (default 2)")
    parser.add_argument("--max", type=int, default=20, dest="max_len", help="longest word to keep (default 20)")
    parser.add_argument("--lower", action="store_true", help="write everything lowercase")
    parser.add_argument("--fold-accents", action="store_true", help="write Earendil rather than Eärendil")
    args = parser.parse_args()

    missing = [f for f in args.files if not f.is_file()]
    if missing:
        print("not found: " + ", ".join(str(f) for f in missing), file=sys.stderr)
        return 1

    text = ""
    for path in args.files:
        try:
            text += read_any(path) + "\n"
        except RuntimeError as err:
            print(str(err), file=sys.stderr)
            return 1

    print("read {:,} characters from {} file(s)".format(len(text), len(args.files)))

    evidence = proper_noun_evidence(text)
    print("  words seen capitalised mid sentence: {:,}".format(len(evidence)))

    names, words = names_and_words(text, evidence, args.min_len, args.max_len)
    multi = [v for k, v in names.items() if " " in k]

    stem = args.files[0].stem
    out_dir = args.out_dir or args.files[0].parent
    out_dir.mkdir(parents=True, exist_ok=True)

    names_path = out_dir / (stem + ".names.txt")
    words_path = out_dir / (stem + ".words.txt")
    wrote_names = write(names_path, names.values(), args.lower, args.fold_accents)
    wrote_words = write(words_path, words.values(), args.lower, args.fold_accents)

    print("  names:  {:,} ({:,} of them more than one word)".format(wrote_names, len(multi)))
    print("  words:  {:,}".format(wrote_words))
    print("\nwrote " + str(names_path))
    print("wrote " + str(words_path))
    if multi:
        print("\nfirst few multi word names, in the order they appear:")
        for phrase in multi[:10]:
            print("  " + phrase)
    return 0


if __name__ == "__main__":
    sys.exit(main())
