"""Generate lexical reading proposals from the pinned snapshot and dictionary."""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import re
import sys
import tempfile
import unicodedata
import zipfile
from collections import Counter
from pathlib import Path

from sudachipy import Dictionary, SplitMode

DICTIONARY_SHA256 = "b38318ca26a444cd713a5a377a353308ef38c733c64cc0be905122527516c793"


def kana(text: str) -> str:
    normalized = unicodedata.normalize("NFKC", text)
    return "".join(chr(ord(c) + 0x60) if "ぁ" <= c <= "ゖ" else c for c in normalized)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dictionary", required=True, type=Path)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if sys.version_info[:3] != (3, 15, 2):
        raise ValueError("Reading generation requires Python 3.15.2")
    if importlib.metadata.version("sudachipy") != "0.7.0":
        raise ValueError("Reading generation requires SudachiPy 0.7.0")
    with args.dictionary.open("rb") as source:
        if hashlib.file_digest(source, "sha256").hexdigest() != DICTIONARY_SHA256:
            raise ValueError("Sudachi dictionary checksum mismatch")
    decoded: object = json.loads(args.input.read_text(encoding="utf-8"))
    if not isinstance(decoded, list) or not all(isinstance(x, str) for x in decoded):
        raise ValueError("Reading input must be a list of display names")
    names: list[str] = []
    for item in decoded:
        if not isinstance(item, str):
            raise ValueError("Invalid name")
        names.append(item)
    with tempfile.TemporaryDirectory(prefix="phonebook-dictionary-") as temporary:
        dictionary_path = Path(temporary) / "system.dic"
        with zipfile.ZipFile(args.dictionary) as archive:
            entries = [n for n in archive.namelist() if n.endswith("/system_full.dic")]
            if len(entries) != 1:
                raise ValueError("Dictionary archive must contain one full dictionary")
            dictionary_path.write_bytes(archive.read(entries[0]))
        dictionary = Dictionary(dict=str(dictionary_path))
        fine = dictionary.tokenizer(SplitMode.A)
        coarse = dictionary.tokenizer(SplitMode.C)
        lexicon: Counter[tuple[str, str]] = Counter()
        readings: list[str] = []
        for name in names:
            readings.append(
                "".join(kana(t.reading_form()) for t in coarse.tokenize(name))
            )
            for token in fine.tokenize(name):
                if not token.is_oov():
                    lexicon[token.surface(), kana(token.reading_form())] += 1
        entries_out = [(s, r, n) for (s, r), n in sorted(lexicon.items())]
        characters = {c for name in names for c in name if "一" <= c <= "鿿"}
        characters.update("役約")
        for character in sorted(characters):
            choices = sorted(
                {
                    kana(t.reading_form())
                    for t in dictionary.lookup(character)
                    if re.fullmatch(r"[ァ-ヶー]+", kana(t.reading_form()))
                }
            )
            entries_out.extend((character, reading, 1) for reading in choices)
        args.output.write_text(
            json.dumps(
                {"readings": readings, "lexicon": entries_out},
                ensure_ascii=False,
                separators=(",", ":"),
            ),
            encoding="utf-8",
        )
        dictionary.close()


if __name__ == "__main__":
    main()
