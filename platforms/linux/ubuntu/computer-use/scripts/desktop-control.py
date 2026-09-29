#!/usr/bin/env python3
"""Inspect and control accessible GNOME application widgets.

Read-only commands are the default. Mutating commands require --apply.
This uses GNOME's AT-SPI accessibility bus, avoiding brittle screen
coordinates on fractionally scaled Wayland desktops.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import time
import warnings
from collections import deque
from dataclasses import dataclass
from typing import Iterable

try:
    import pyatspi
except ImportError as exc:  # pragma: no cover - environment diagnostic
    raise SystemExit(
        "desktop-control: python3-pyatspi is required "
        "(sudo apt-get install python3-pyatspi)"
    ) from exc

warnings.filterwarnings("ignore", category=DeprecationWarning)


REDACTED = "[redacted protected field]"
TARGET_TOKEN_MAX_AGE_SECONDS = 30.0
INPUT_TOKEN_MAX_AGE_SECONDS = 30.0
MAX_TYPE_CHARS = 256
WINDOW_ROLES = {
    "frame",
    "window",
    "dialog",
    "alert",
    "file chooser",
    "color chooser",
    "font chooser",
}
MODIFIER_CODES = {"ctrl": 29, "shift": 42, "alt": 56, "super": 125, "meta": 125}
KEY_CODES = {
    "escape": 1,
    "1": 2,
    "2": 3,
    "3": 4,
    "4": 5,
    "5": 6,
    "6": 7,
    "7": 8,
    "8": 9,
    "9": 10,
    "0": 11,
    "minus": 12,
    "equal": 13,
    "backspace": 14,
    "tab": 15,
    "q": 16,
    "w": 17,
    "e": 18,
    "r": 19,
    "t": 20,
    "y": 21,
    "u": 22,
    "i": 23,
    "o": 24,
    "p": 25,
    "leftbrace": 26,
    "rightbrace": 27,
    "return": 28,
    "enter": 28,
    "a": 30,
    "s": 31,
    "d": 32,
    "f": 33,
    "g": 34,
    "h": 35,
    "j": 36,
    "k": 37,
    "l": 38,
    "semicolon": 39,
    "apostrophe": 40,
    "grave": 41,
    "z": 44,
    "x": 45,
    "c": 46,
    "v": 47,
    "b": 48,
    "n": 49,
    "m": 50,
    "comma": 51,
    "dot": 52,
    "slash": 53,
    "space": 57,
    "f1": 59,
    "f2": 60,
    "f3": 61,
    "f4": 62,
    "f5": 63,
    "f6": 64,
    "f7": 65,
    "f8": 66,
    "f9": 67,
    "f10": 68,
    "f11": 87,
    "f12": 88,
    "home": 102,
    "up": 103,
    "pageup": 104,
    "left": 105,
    "right": 106,
    "end": 107,
    "down": 108,
    "pagedown": 109,
    "insert": 110,
    "delete": 111,
}


@dataclass
class Match:
    node: object
    path: str
    depth: int


@dataclass
class Traversal:
    matches: list[Match]
    visited: int
    truncated_by_depth: bool
    truncated_by_nodes: bool

    @property
    def complete(self) -> bool:
        return not self.truncated_by_depth and not self.truncated_by_nodes


def safe(callable_, default=None):
    try:
        return callable_()
    except Exception:
        return default


def node_name(node) -> str:
    return safe(lambda: node.name, "") or ""


def node_role(node) -> str:
    return safe(node.getRoleName, "unknown") or "unknown"


def node_states(node) -> list[str]:
    states = safe(lambda: node.getState().getStates(), []) or []
    return sorted(pyatspi.stateToString(state) for state in states)


def node_actions(node) -> list[str]:
    count = safe(node.get_n_actions, 0) or 0
    return [safe(lambda i=i: node.get_action_name(i), "") for i in range(count)]


def node_bounds(node):
    component = safe(node.queryComponent)
    if component is None:
        return None
    extents = safe(lambda: component.getExtents(pyatspi.DESKTOP_COORDS))
    if extents is None:
        return None
    return [extents.x, extents.y, extents.width, extents.height]


def is_sensitive(node, role: str | None = None, states: list[str] | None = None) -> bool:
    role = (role if role is not None else node_role(node)).casefold()
    states = states if states is not None else node_states(node)
    return "password" in role or any(
        state.casefold() == "protected" for state in states
    )


def node_info(match: Match, include_text: bool = False) -> dict:
    node = match.node
    role = node_role(node)
    states = node_states(node)
    sensitive = is_sensitive(node, role, states)
    info = {
        "path": match.path,
        "depth": match.depth,
        "name": REDACTED if sensitive else node_name(node),
        "role": role,
        "description": REDACTED if sensitive else safe(node.get_description, "") or "",
        "states": states,
        "actions": node_actions(node),
        "bounds": node_bounds(node),
    }
    if include_text and not sensitive:
        text_iface = safe(node.queryText)
        if text_iface is not None:
            count = safe(lambda: text_iface.characterCount, 0) or 0
            text = safe(lambda: text_iface.getText(0, min(count, 500)), "") or ""
            info["text_preview"] = text
            info["text_truncated"] = count > 500
    return info


def desktop():
    return pyatspi.Registry.getDesktop(0)


def children(node) -> Iterable[tuple[int, object]]:
    count = safe(lambda: node.childCount, 0) or 0
    for index in range(count):
        child = safe(lambda index=index: node[index])
        if child is not None:
            yield index, child


def applications() -> list:
    root = desktop()
    return [child for _, child in children(root)]


def select_application(query: str):
    apps = applications()
    exact = [app for app in apps if node_name(app).casefold() == query.casefold()]
    matches = exact or [app for app in apps if query.casefold() in node_name(app).casefold()]
    if not matches:
        names = ", ".join(sorted(filter(None, (node_name(app) for app in apps))))
        raise SystemExit(f"desktop-control: application not found: {query!r}; available: {names}")
    if len(matches) > 1:
        names = ", ".join(repr(node_name(app)) for app in matches)
        raise SystemExit(f"desktop-control: application is ambiguous: {names}")
    return matches[0]


def walk(root, max_depth: int, max_nodes: int) -> Traversal:
    queue = deque([(root, "", 0)])
    matches = []
    visited = 0
    truncated_by_depth = False
    while queue and visited < max_nodes:
        node, path, depth = queue.popleft()
        visited += 1
        matches.append(Match(node=node, path=path or "root", depth=depth))
        if depth >= max_depth:
            if (safe(lambda: node.childCount, 0) or 0) > 0:
                truncated_by_depth = True
            continue
        for index, child in children(node):
            child_path = f"{path}/{index}" if path else str(index)
            queue.append((child, child_path, depth + 1))
    return Traversal(
        matches=matches,
        visited=visited,
        truncated_by_depth=truncated_by_depth,
        truncated_by_nodes=bool(queue),
    )


def is_showing(node) -> bool:
    states = set(node_states(node))
    return "showing" in states and "visible" in states


def find_matches(args) -> Traversal:
    app = select_application(args.app)
    matches = []
    name_query = (args.name or "").casefold()
    role_query = (args.role or "").casefold()
    traversal = walk(app, args.max_depth, args.max_nodes)
    for match in traversal.matches:
        role = node_role(match.node)
        states = node_states(match.node)
        sensitive = is_sensitive(match.node, role, states)
        name = "" if sensitive else node_name(match.node)
        if name_query:
            candidate = name.casefold()
            if args.exact_name and candidate != name_query:
                continue
            if not args.exact_name and name_query not in candidate:
                continue
        if role_query and role.casefold() != role_query:
            continue
        if args.showing and not is_showing(match.node):
            continue
        matches.append(match)
    traversal.matches = matches
    return traversal


def traversal_info(traversal: Traversal) -> dict:
    return {
        "complete": traversal.complete,
        "visited": traversal.visited,
        "truncated_by_depth": traversal.truncated_by_depth,
        "truncated_by_nodes": traversal.truncated_by_nodes,
    }


def require_complete(traversal: Traversal) -> None:
    if traversal.complete:
        return
    limits = []
    if traversal.truncated_by_depth:
        limits.append("depth")
    if traversal.truncated_by_nodes:
        limits.append("node count")
    raise SystemExit(
        "desktop-control: accessibility search was truncated by "
        + " and ".join(limits)
        + "; increase the relevant bound before selecting a mutation target"
    )


def choose_match(args) -> Match:
    traversal = find_matches(args)
    require_complete(traversal)
    matches = traversal.matches
    if not matches:
        raise SystemExit("desktop-control: no matching accessible element")
    if args.nth < 1 or args.nth > len(matches):
        raise SystemExit(
            f"desktop-control: --nth {args.nth} is outside 1..{len(matches)}"
        )
    if len(matches) > 1 and not args.nth_explicit:
        summaries = [node_info(match) for match in matches[:20]]
        print(json.dumps(summaries, indent=2, ensure_ascii=False))
        raise SystemExit(
            f"desktop-control: {len(matches)} elements matched; rerun with --nth N"
        )
    return matches[args.nth - 1]


def target_fingerprint(match: Match, verb: str) -> str:
    identity = {
        "path": match.path,
        "name": node_name(match.node),
        "role": node_role(match.node),
        "bounds": node_bounds(match.node),
        "verb": verb,
    }
    encoded = json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def issue_target_token(match: Match, verb: str) -> str:
    return f"{time.time_ns()}:{target_fingerprint(match, verb)}"


def validate_target_token(match: Match, token: str, verb: str) -> None:
    issued_raw, separator, expected_fingerprint = token.partition(":")
    try:
        issued_at = int(issued_raw) / 1_000_000_000
    except ValueError:
        issued_at = 0.0
    age = time.time() - issued_at
    if (
        not separator
        or expected_fingerprint != target_fingerprint(match, verb)
        or age < -1.0
        or age > TARGET_TOKEN_MAX_AGE_SECONDS
    ):
        raise SystemExit(
            "desktop-control: preview token is stale or the target changed; "
            "run a fresh dry run"
        )


def focused_window() -> dict:
    for app in applications():
        traversal = walk(app, 4, 500)
        for match in traversal.matches:
            role = node_role(match.node).casefold()
            if role in WINDOW_ROLES and "active" in node_states(match.node):
                return {"app": node_name(app), "window": node_name(match.node)}
    return {"app": "", "window": ""}


def key_sequence(chord: str) -> list[str]:
    tokens = [token.strip().casefold() for token in chord.split("+")]
    if not tokens or any(not token for token in tokens):
        raise SystemExit("desktop-control: --key must be a chord such as 'ctrl+s'")
    modifiers: list[str] = []
    key = None
    for token in tokens:
        if token in MODIFIER_CODES and key is None:
            if token in modifiers:
                raise SystemExit(
                    f"desktop-control: duplicate modifier in --key: {token!r}"
                )
            modifiers.append(token)
            continue
        if key is not None:
            raise SystemExit(
                "desktop-control: --key accepts exactly one non-modifier key"
            )
        key = token
    if key is None:
        raise SystemExit(
            "desktop-control: --key needs a non-modifier key, such as 'ctrl+s'"
        )
    if key not in KEY_CODES:
        choices = ", ".join(sorted(KEY_CODES))
        raise SystemExit(f"desktop-control: unsupported key {key!r}; choices: {choices}")
    sequence = [f"{MODIFIER_CODES[modifier]}:1" for modifier in modifiers]
    sequence += [f"{KEY_CODES[key]}:1", f"{KEY_CODES[key]}:0"]
    sequence += [f"{MODIFIER_CODES[modifier]}:0" for modifier in reversed(modifiers)]
    return sequence


def validated_text(text: str) -> str:
    if not text:
        raise SystemExit("desktop-control: --text must not be empty")
    if len(text) > MAX_TYPE_CHARS:
        raise SystemExit(
            f"desktop-control: --text is limited to {MAX_TYPE_CHARS} characters"
        )
    for character in text:
        if not 32 <= ord(character) <= 126:
            raise SystemExit(
                "desktop-control: --text accepts printable ASCII only; "
                "send Return, Tab, or arrow keys with --kind key"
            )
    return text


def ydotool_socket_path() -> str:
    socket = os.environ.get("YDOTOOL_SOCKET", "")
    if not socket:
        runtime = os.environ.get("XDG_RUNTIME_DIR", "")
        if runtime:
            socket = os.path.join(runtime, ".ydotool_socket")
    return socket


def run_ydotool(command: str, arguments: list[str]) -> None:
    socket = ydotool_socket_path()
    if not socket or not os.path.exists(socket):
        raise SystemExit(
            "desktop-control: ydotool's private socket is unavailable; "
            "fix provisioning with setup-computer-assistant.sh --apply"
        )
    environment = dict(os.environ)
    environment["YDOTOOL_SOCKET"] = socket
    try:
        completed = subprocess.run(
            ["ydotool", command, *arguments],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
            env=environment,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise SystemExit(f"desktop-control: ydotool {command} failed: {exc}") from exc
    if completed.returncode != 0:
        detail = (
            completed.stderr or completed.stdout or ""
        ).strip() or f"exit {completed.returncode}"
        raise SystemExit(f"desktop-control: ydotool {command} failed: {detail}")


def input_fingerprint(payload: dict, context: dict) -> str:
    identity = {"payload": payload, "context": context}
    encoded = json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def issue_input_token(payload: dict, context: dict) -> str:
    return f"{time.time_ns()}:{input_fingerprint(payload, context)}"


def validate_input_token(payload: dict, context: dict, token: str) -> None:
    issued_raw, separator, expected_fingerprint = token.partition(":")
    try:
        issued_at = int(issued_raw) / 1_000_000_000
    except ValueError:
        issued_at = 0.0
    age = time.time() - issued_at
    if (
        not separator
        or expected_fingerprint != input_fingerprint(payload, context)
        or age < -1.0
        or age > INPUT_TOKEN_MAX_AGE_SECONDS
    ):
        raise SystemExit(
            "desktop-control: input preview token is stale or the focused window "
            "changed; run a fresh dry run"
        )


class NthAction(argparse.Action):
    def __call__(self, parser, namespace, values, option_string=None):
        namespace.nth = values
        namespace.nth_explicit = True


def add_match_args(parser, *, require_name: bool = False):
    parser.add_argument("--app", required=True, help="AT-SPI application name")
    parser.add_argument("--name", required=require_name, help="element name substring")
    parser.add_argument("--exact-name", action="store_true")
    parser.add_argument("--role", help="exact AT-SPI role name")
    parser.add_argument("--showing", action="store_true", help="only visible/showing elements")
    parser.set_defaults(nth=1, nth_explicit=False)
    parser.add_argument("--nth", type=int, action=NthAction, metavar="N")
    parser.add_argument("--max-depth", type=int, default=30)
    parser.add_argument("--max-nodes", type=int, default=5000)


def command_apps(_args):
    output = [
        {"name": node_name(app), "role": node_role(app), "children": safe(lambda: app.childCount, 0)}
        for app in applications()
    ]
    print(json.dumps(output, indent=2, ensure_ascii=False))


def command_tree(args):
    app = select_application(args.app)
    output = []
    traversal = walk(app, args.max_depth, args.max_nodes)
    for match in traversal.matches:
        info = node_info(match, include_text=args.include_text)
        if args.all or info["name"] or info["actions"]:
            output.append(info)
    print(json.dumps({
        "traversal": traversal_info(traversal),
        "results": output,
    }, indent=2, ensure_ascii=False))


def command_find(args):
    if not args.name and not args.role:
        raise SystemExit("desktop-control: find requires --name and/or --role")
    traversal = find_matches(args)
    output = [
        node_info(match, include_text=args.include_text)
        for match in traversal.matches
    ]
    print(json.dumps({
        "traversal": traversal_info(traversal),
        "results": output,
    }, indent=2, ensure_ascii=False))


def require_apply(args, verb: str, match: Match):
    info = node_info(match)
    if not args.apply:
        token = issue_target_token(match, verb)
        print(json.dumps({
            "dry_run": True,
            "would": verb,
            "target": info,
            "target_token": token,
            "apply_requires": "--expect-token TARGET_TOKEN --apply",
        }, indent=2, ensure_ascii=False))
        return False
    if not args.expect_token:
        raise SystemExit(
            "desktop-control: --apply requires --expect-token from a fresh dry run"
        )
    validate_target_token(match, args.expect_token, verb)
    return True


def wait_for_state(node, state: str, timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    while True:
        if state in node_states(node):
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.05)


def current_text(node) -> str | None:
    text_iface = safe(node.queryText)
    if text_iface is None:
        return None
    count = safe(lambda: text_iface.characterCount)
    if count is None:
        return None
    return safe(lambda: text_iface.getText(0, count))


def wait_for_text(node, expected: str, timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    while True:
        if current_text(node) == expected:
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.05)


def focus_and_wait(node, timeout: float) -> None:
    if "focused" in node_states(node):
        return
    component = safe(node.queryComponent)
    focused = component is not None and safe(component.grabFocus, False)
    if not focused:
        raise SystemExit("desktop-control: element cannot accept focus")
    if not wait_for_state(node, "focused", timeout):
        raise SystemExit(
            "desktop-control: focus request was accepted but the outcome is unknown; "
            "take a fresh observation before retrying"
        )


def command_action(args):
    match = choose_match(args)
    target = node_info(match)
    actions = node_actions(match.node)
    if args.action not in actions:
        raise SystemExit(
            f"desktop-control: action {args.action!r} unavailable; choices: {actions}"
        )
    if not require_apply(args, f"invoke action {args.action!r}", match):
        return
    index = actions.index(args.action)
    if not match.node.do_action(index):
        raise SystemExit("desktop-control: action returned failure")
    print(json.dumps({
        "dispatched": True,
        "action": args.action,
        "target": target,
        "outcome": "unverified",
        "next_step": "take a fresh observation before retrying or continuing",
    }, indent=2, ensure_ascii=False))


def command_focus(args):
    match = choose_match(args)
    if not require_apply(args, "grab keyboard focus", match):
        return
    focus_and_wait(match.node, args.wait_seconds)
    print(json.dumps({
        "applied": True,
        "outcome": "verified",
        "focused": node_info(match),
    }, indent=2, ensure_ascii=False))


def command_set_text(args):
    match = choose_match(args)
    role = node_role(match.node).casefold()
    if is_sensitive(match.node, role):
        raise SystemExit("desktop-control: refusing to write a password field")
    editable = safe(match.node.queryEditableText)
    if editable is None:
        raise SystemExit("desktop-control: element does not expose editable text")
    if not require_apply(args, f"replace editable text ({len(args.text)} characters)", match):
        return
    focus_and_wait(match.node, args.wait_seconds)
    if not editable.setTextContents(args.text):
        raise SystemExit("desktop-control: setting text returned failure")
    if not wait_for_text(match.node, args.text, args.wait_seconds):
        raise SystemExit(
            "desktop-control: text request was accepted but readback did not match; "
            "take a fresh observation before retrying"
        )
    print(json.dumps({
        "applied": True,
        "outcome": "verified",
        "text_length": len(args.text),
        "target": node_info(match),
    }, indent=2, ensure_ascii=False))


def command_windows(args):
    apps = [select_application(args.app)] if args.app else applications()
    windows = []
    scanned = 0
    truncated = False
    for app in apps:
        traversal = walk(app, args.max_depth, args.max_nodes)
        truncated = truncated or not traversal.complete
        scanned += 1
        for match in traversal.matches:
            role = node_role(match.node).casefold()
            if role not in WINDOW_ROLES:
                continue
            states = node_states(match.node)
            showing = "showing" in states and "visible" in states
            if args.showing and not showing:
                continue
            info = node_info(match)
            info["app"] = node_name(app)
            info["showing"] = showing
            info["active"] = "active" in states
            windows.append(info)
    print(json.dumps({
        "complete": not truncated,
        "scanned_apps": scanned,
        "windows": windows,
    }, indent=2, ensure_ascii=False))


def command_input(args):
    if args.kind == "key":
        if not args.key:
            raise SystemExit("desktop-control: --kind key requires --key, e.g. 'ctrl+s'")
        if args.text is not None:
            raise SystemExit("desktop-control: --text is only valid with --kind type")
        payload = {"kind": "key", "key": args.key.casefold()}
        ydotool_arguments = ["key", *key_sequence(args.key)]
    else:
        if args.text is None:
            raise SystemExit("desktop-control: --kind type requires --text")
        if args.key is not None:
            raise SystemExit("desktop-control: --key is only valid with --kind key")
        text = validated_text(args.text)
        payload = {"kind": "type", "text": text}
        ydotool_arguments = ["type", "--escape=0", "--", text]

    context = focused_window()
    if not args.apply:
        token = issue_input_token(payload, context)
        print(json.dumps({
            "dry_run": True,
            "would": payload,
            "focused_window": context,
            "target_token": token,
            "apply_requires": "--expect-token TARGET_TOKEN --apply",
        }, indent=2, ensure_ascii=False))
        return
    if not args.expect_token:
        raise SystemExit(
            "desktop-control: --apply requires --expect-token from a fresh dry run"
        )
    validate_input_token(payload, context, args.expect_token)
    run_ydotool(ydotool_arguments[0], ydotool_arguments[1:])
    print(json.dumps({
        "dispatched": True,
        **payload,
        "focused_window": context,
        "outcome": "unverified",
        "next_step": "take a fresh observation (screenshot or find) before retrying or continuing",
    }, indent=2, ensure_ascii=False))


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        description="Inspect/control GNOME apps through AT-SPI; mutations require --apply."
    )
    sub = result.add_subparsers(dest="command", required=True)

    apps = sub.add_parser("apps", help="list accessible applications")
    apps.set_defaults(func=command_apps)

    tree = sub.add_parser("tree", help="dump useful elements from one app")
    tree.add_argument("--app", required=True)
    tree.add_argument("--max-depth", type=int, default=12)
    tree.add_argument("--max-nodes", type=int, default=1000)
    tree.add_argument("--all", action="store_true", help="include unnamed/no-action nodes")
    tree.add_argument("--include-text", action="store_true")
    tree.set_defaults(func=command_tree)

    find = sub.add_parser("find", help="find elements by accessible name and/or role")
    add_match_args(find)
    find.add_argument("--include-text", action="store_true")
    find.set_defaults(func=command_find)

    action = sub.add_parser("action", help="invoke an advertised accessibility action")
    add_match_args(action, require_name=True)
    action.add_argument("--action", default="click")
    action.add_argument("--expect-token")
    action.add_argument("--apply", action="store_true")
    action.set_defaults(func=command_action)

    focus = sub.add_parser("focus", help="move keyboard focus to an element")
    add_match_args(focus)
    focus.add_argument("--expect-token")
    focus.add_argument("--wait-seconds", type=float, default=2.0)
    focus.add_argument("--apply", action="store_true")
    focus.set_defaults(func=command_focus)

    set_text = sub.add_parser("set-text", help="replace an editable field's text")
    add_match_args(set_text)
    set_text.add_argument("--text", required=True)
    set_text.add_argument("--expect-token")
    set_text.add_argument("--wait-seconds", type=float, default=2.0)
    set_text.add_argument("--apply", action="store_true")
    set_text.set_defaults(func=command_set_text)

    windows = sub.add_parser("windows", help="list top-level windows (frames and dialogs)")
    windows.add_argument("--app", help="only this AT-SPI application")
    windows.add_argument("--showing", action="store_true", help="only showing/visible windows")
    windows.add_argument("--max-depth", type=int, default=4)
    windows.add_argument("--max-nodes", type=int, default=2000)
    windows.set_defaults(func=command_windows)

    input_command = sub.add_parser(
        "input", help="send one bounded key chord or text string through ydotool"
    )
    input_command.add_argument("--kind", required=True, choices=["key", "type"])
    input_command.add_argument("--key", help="key or chord for --kind key, e.g. ctrl+s")
    input_command.add_argument("--text", help="printable ASCII text for --kind type")
    input_command.add_argument("--expect-token")
    input_command.add_argument("--apply", action="store_true")
    input_command.set_defaults(func=command_input)

    return result


def main() -> int:
    args = parser().parse_args()
    args.func(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
