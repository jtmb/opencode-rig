#!/usr/bin/env python3
"""Inspect and control accessible GNOME application widgets.

Read-only commands are the default. Mutating commands require --apply.
This uses GNOME's AT-SPI accessibility bus, avoiding brittle screen
coordinates on fractionally scaled Wayland desktops.
"""

from __future__ import annotations

import argparse
import json
import sys
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


PASSWORD_ROLES = {"password text"}


@dataclass
class Match:
    node: object
    path: str
    depth: int


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


def node_info(match: Match, include_text: bool = False) -> dict:
    node = match.node
    info = {
        "path": match.path,
        "depth": match.depth,
        "name": node_name(node),
        "role": node_role(node),
        "description": safe(node.get_description, "") or "",
        "states": node_states(node),
        "actions": node_actions(node),
        "bounds": node_bounds(node),
    }
    if include_text:
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


def walk(root, max_depth: int, max_nodes: int) -> Iterable[Match]:
    queue = deque([(root, "", 0)])
    visited = 0
    while queue and visited < max_nodes:
        node, path, depth = queue.popleft()
        visited += 1
        yield Match(node=node, path=path or "root", depth=depth)
        if depth >= max_depth:
            continue
        for index, child in children(node):
            child_path = f"{path}/{index}" if path else str(index)
            queue.append((child, child_path, depth + 1))


def is_showing(node) -> bool:
    states = set(node_states(node))
    return "showing" in states and "visible" in states


def find_matches(args) -> list[Match]:
    app = select_application(args.app)
    matches = []
    name_query = (args.name or "").casefold()
    role_query = (args.role or "").casefold()
    for match in walk(app, args.max_depth, args.max_nodes):
        name = node_name(match.node)
        role = node_role(match.node)
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
    return matches


def choose_match(args) -> Match:
    matches = find_matches(args)
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
    for match in walk(app, args.max_depth, args.max_nodes):
        info = node_info(match, include_text=args.include_text)
        if args.all or info["name"] or info["actions"]:
            output.append(info)
    print(json.dumps(output, indent=2, ensure_ascii=False))


def command_find(args):
    if not args.name and not args.role:
        raise SystemExit("desktop-control: find requires --name and/or --role")
    output = [node_info(match, include_text=args.include_text) for match in find_matches(args)]
    print(json.dumps(output, indent=2, ensure_ascii=False))


def require_apply(args, verb: str, match: Match):
    info = node_info(match)
    if not args.apply:
        print(json.dumps({"dry_run": True, "would": verb, "target": info}, indent=2, ensure_ascii=False))
        return False
    return True


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
        "applied": True,
        "action": args.action,
        "target": target,
        "post_state": node_info(match),
    }, indent=2, ensure_ascii=False))


def command_focus(args):
    match = choose_match(args)
    if not require_apply(args, "grab keyboard focus", match):
        return
    component = safe(match.node.queryComponent)
    focused = component is not None and safe(component.grabFocus, False)
    if not focused:
        raise SystemExit("desktop-control: element cannot accept focus")
    print(json.dumps({"applied": True, "focused": node_info(match)}, indent=2, ensure_ascii=False))


def command_set_text(args):
    match = choose_match(args)
    role = node_role(match.node).casefold()
    if role in PASSWORD_ROLES or "password" in role:
        raise SystemExit("desktop-control: refusing to write a password field")
    editable = safe(match.node.queryEditableText)
    if editable is None:
        raise SystemExit("desktop-control: element does not expose editable text")
    if not require_apply(args, f"replace text with {args.text!r}", match):
        return
    if not editable.setTextContents(args.text):
        raise SystemExit("desktop-control: setting text returned failure")
    print(json.dumps({"applied": True, "target": node_info(match)}, indent=2, ensure_ascii=False))


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
    action.add_argument("--apply", action="store_true")
    action.set_defaults(func=command_action)

    focus = sub.add_parser("focus", help="move keyboard focus to an element")
    add_match_args(focus)
    focus.add_argument("--apply", action="store_true")
    focus.set_defaults(func=command_focus)

    set_text = sub.add_parser("set-text", help="replace an editable field's text")
    add_match_args(set_text)
    set_text.add_argument("--text", required=True)
    set_text.add_argument("--apply", action="store_true")
    set_text.set_defaults(func=command_set_text)

    return result


def main() -> int:
    args = parser().parse_args()
    args.func(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
