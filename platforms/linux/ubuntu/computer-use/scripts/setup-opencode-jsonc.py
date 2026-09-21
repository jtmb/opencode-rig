#!/usr/bin/env python3
"""Small strict JSONC reader used only by the v2 setup and verify scripts."""

from __future__ import annotations

import json
import sys
from typing import Any


def _without_comments(text: str) -> str:
    if "\x00" in text:
        raise ValueError("JSONC contains a NUL byte")
    out: list[str] = []
    index = 0
    in_string = False
    escaped = False
    while index < len(text):
        char = text[index]
        if in_string:
            out.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            index += 1
            continue
        if char == '"':
            in_string = True
            out.append(char)
            index += 1
        elif char == "/" and index + 1 < len(text) and text[index + 1] == "/":
            index += 2
            while index < len(text) and text[index] not in "\r\n":
                index += 1
        elif char == "/" and index + 1 < len(text) and text[index + 1] == "*":
            end = text.find("*/", index + 2)
            if end < 0:
                raise ValueError("unterminated JSONC block comment")
            out.append(" " * (end + 2 - index))
            index = end + 2
        else:
            out.append(char)
            index += 1
    if in_string or escaped:
        raise ValueError("unterminated JSON string")
    return "".join(out)


def _without_trailing_commas(text: str) -> str:
    out: list[str] = []
    index = 0
    in_string = False
    escaped = False
    while index < len(text):
        char = text[index]
        if in_string:
            out.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            index += 1
            continue
        if char == '"':
            in_string = True
            out.append(char)
            index += 1
            continue
        if char == ",":
            lookahead = index + 1
            while lookahead < len(text) and text[lookahead].isspace():
                lookahead += 1
            if lookahead < len(text) and text[lookahead] in "]}":
                index += 1
                continue
        out.append(char)
        index += 1
    return "".join(out)


def _reject_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON object key: {key}")
        result[key] = value
    return result


def parse_jsonc(text: str) -> Any:
    cleaned = _without_trailing_commas(_without_comments(text))
    return json.loads(cleaned, object_pairs_hook=_reject_duplicates)


def load_jsonc(path: str) -> Any:
    with open(path, encoding="utf-8") as handle:
        return parse_jsonc(handle.read())


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: setup-opencode-jsonc.py FILE")
    value = load_jsonc(sys.argv[1])
    if not isinstance(value, dict):
        raise SystemExit("top-level JSONC value must be an object")
