#!/usr/bin/env python3
"""Small strict JSONC reader used only by the v2 setup and verify scripts."""

from __future__ import annotations

import json
import os
from pathlib import Path
import stat
import sys
import tempfile
from typing import Any


AGENT_MODELS = {
    "build": "openai/gpt-6-luna#max",
    "plan": "openai/gpt-6-sol#max",
    "architect": "openai/gpt-6-sol#max",
    "explore": "openai/gpt-6-luna#max",
    "general": "openai/gpt-6-luna#max",
}
SUPPORTED_VARIANTS = {"none", "low", "medium", "high", "xhigh", "max"}


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


def _legacy_model(model: object) -> bool:
    if isinstance(model, str):
        return model.startswith("openai/gpt-5.6")
    return isinstance(model, dict) and model.get("providerID") == "openai" and isinstance(
        model.get("model"), str
    ) and model["model"].startswith("gpt-5.6")


def verify_agent_models(data: object, *, source: bool = False) -> None:
    """Validate Open Rig's role split without rejecting unrelated custom models."""
    agents = data.get("agents") if isinstance(data, dict) else None
    if not isinstance(agents, dict):
        raise ValueError("agents must be an object with the configured Open Rig roles")
    for name, definition in agents.items():
        if not isinstance(definition, dict):
            raise ValueError(f"agents.{name} must be an object")
        if _legacy_model(definition.get("model")):
            raise ValueError(f"agents.{name} still selects a GPT-5.6 model")
    for name, expected in AGENT_MODELS.items():
        definition = agents.get(name)
        model = definition.get("model") if isinstance(definition, dict) else None
        if model is None:
            raise ValueError(f"agents.{name} must have an explicit model")
        if source and model != expected:
            raise ValueError(f"agents.{name} must select {expected}")
        if not isinstance(model, (str, dict)):
            raise ValueError(f"agents.{name}.model must be a model reference")
        other_family = "openai/gpt-6-sol" if "luna" in expected else "openai/gpt-6-luna"
        if isinstance(model, str):
            base, separator, variant = model.partition("#")
            if base == other_family:
                raise ValueError(f"agents.{name} must select the correct GPT-6 role family")
            if base in {"openai/gpt-6-luna", "openai/gpt-6-sol"} and separator and variant not in SUPPORTED_VARIANTS:
                raise ValueError(f"agents.{name} has an unsupported model variant")
        if isinstance(model, dict) and model.get("providerID") == "openai":
            model_id = model.get("model")
            if model_id == other_family.split("/", 1)[1]:
                raise ValueError(f"agents.{name} must select the correct GPT-6 role family")
            if model_id in {"gpt-6-luna", "gpt-6-sol"} and model.get("variant", "max") not in SUPPORTED_VARIANTS:
                raise ValueError(f"agents.{name} has an unsupported model variant")


def reconcile_agent_models(data: dict[str, Any], source: dict[str, Any]) -> bool:
    """Upgrade owned legacy roles while preserving any unrelated model choice."""
    verify_agent_models(source, source=True)
    if not isinstance(data, dict):
        raise ValueError("configuration must be an object")
    agents = data.setdefault("agents", {})
    if not isinstance(agents, dict):
        raise ValueError("agents must be an object")
    changed = False
    for name, expected in AGENT_MODELS.items():
        if name not in agents:
            agents[name] = json.loads(json.dumps(source["agents"][name]))
            changed = True
            continue
        definition = agents[name]
        if not isinstance(definition, dict):
            raise ValueError(f"agents.{name} must be an object")
        model = definition.get("model")
        if model is None:
            definition["model"] = expected
            changed = True
        elif isinstance(model, str):
            base, _, variant = model.partition("#")
            if base.startswith("openai/gpt-5.6"):
                if variant and variant not in SUPPORTED_VARIANTS:
                    raise ValueError(f"agents.{name} has an unsupported model variant")
                definition["model"] = expected.split("#", 1)[0] + "#" + (variant or "max")
                changed = True
            elif base in {"openai/gpt-6-luna", "openai/gpt-6-sol"} and base != expected.split("#", 1)[0]:
                definition["model"] = expected
                changed = True
        elif isinstance(model, dict) and model.get("providerID") == "openai":
            model_id = model.get("model")
            expected_id = expected.split("#", 1)[0].split("/", 1)[1]
            if _legacy_model(model):
                variant = model.get("variant", "max")
                if variant not in SUPPORTED_VARIANTS:
                    raise ValueError(f"agents.{name} has an unsupported model variant")
                model["model"] = expected_id
                model["variant"] = variant
                changed = True
            elif model_id in {"gpt-6-luna", "gpt-6-sol"} and model_id != expected_id:
                model["model"] = expected_id
                model["variant"] = "max"
                changed = True
    verify_agent_models(data)
    return changed


def apply_agent_models(path: str, data: dict[str, Any]) -> None:
    """Write only a changed, selected profile with its existing file mode."""
    target = Path(path)
    metadata = target.lstat()
    if not stat.S_ISREG(metadata.st_mode):
        raise ValueError("agent model target must be a regular file")
    descriptor, temporary = tempfile.mkstemp(prefix=".agent-models.", suffix=".tmp", dir=target.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2)
            handle.write("\n")
        os.chmod(temporary, stat.S_IMODE(metadata.st_mode))
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


if __name__ == "__main__":
    if len(sys.argv) == 2:
        value = load_jsonc(sys.argv[1])
        if not isinstance(value, dict):
            raise SystemExit("top-level JSONC value must be an object")
    elif len(sys.argv) == 4 and sys.argv[1] in ("--verify-agent-models", "--apply-agent-models"):
        source = load_jsonc(sys.argv[2])
        target = load_jsonc(sys.argv[3])
        verify_agent_models(source, source=True)
        if sys.argv[1] == "--apply-agent-models":
            if reconcile_agent_models(target, source):
                apply_agent_models(sys.argv[3], target)
        else:
            verify_agent_models(target)
    else:
        raise SystemExit("usage: setup-opencode-jsonc.py FILE | --verify-agent-models SOURCE TARGET | --apply-agent-models SOURCE TARGET")
