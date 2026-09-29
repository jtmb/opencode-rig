#!/usr/bin/env python3
"""Focused checks for the private ChatGPT agent and neutral launcher."""

from __future__ import annotations

import json
import os
import re
import stat
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parents[5]
COMPUTER_USE = ROOT / "platforms/linux/ubuntu/computer-use"
AGENT = COMPUTER_USE / "agents/chatgpt-private.md"
LAUNCHER = COMPUTER_USE / "scripts/chatgpt-private.sh"
TMP_ROOT = Path(os.environ.get("OPENCODE_LAUNCHER_TEST_ROOT", "/tmp/opencode"))
RULE_PATTERN = re.compile(
    r"(?m)^  - action: (\"[^\"]+\"|[^\s]+)\n"
    r"    resource: (\"[^\"]+\"|[^\s]+)\n"
    r"    effect: (allow|ask|deny)$"
)


@dataclass(frozen=True)
class PermissionRule:
    """One ordered OpenCode V2 permission rule."""

    action: str
    resource: str
    effect: str


def parse_rules(agent_text: str) -> list[PermissionRule]:
    """Extract the agent's ordered permission rules from Markdown frontmatter."""
    if not agent_text.startswith("---\n"):
        raise AssertionError("agent must start with YAML frontmatter")
    frontmatter_end = agent_text.find("\n---\n", 4)
    if frontmatter_end < 0:
        raise AssertionError("agent frontmatter must have a closing delimiter")
    frontmatter = agent_text[4:frontmatter_end]
    if not re.search(r"(?m)^mode:\s*primary\s*$", frontmatter):
        raise AssertionError("ChatGPT private must be a primary agent")
    permissions_start = frontmatter.find("permissions:\n")
    if permissions_start < 0:
        raise AssertionError("agent must declare restrictive permissions")
    permission_text = frontmatter[permissions_start + len("permissions:\n") :]

    def unquote(value: str) -> str:
        if value.startswith('"') and value.endswith('"'):
            return value[1:-1]
        return value

    matches = RULE_PATTERN.findall(permission_text)
    if len(matches) != len(re.findall(r"(?m)^  - action:", permission_text)):
        raise AssertionError("every permission rule must use the documented frontmatter shape")
    return [
        PermissionRule(unquote(action), unquote(resource), effect)
        for action, resource, effect in matches
    ]


def permission_effect(rules: list[PermissionRule], action: str, resource: str = "*") -> str:
    """Resolve a tool action using OpenCode's last-matching-rule behavior."""
    effect = "ask"
    for rule in rules:
        if rule.action in {"*", action} and rule.resource in {"*", resource}:
            effect = rule.effect
    return effect


def make_stub_binary(path: Path, call_log: Path) -> None:
    """Create a fake OpenCode executable that records its isolated launch context."""
    path.write_text(
        "#!/usr/bin/env python3\n"
        "import json\n"
        "import os\n"
        "import sys\n"
        "from pathlib import Path\n"
        "cwd = Path.cwd()\n"
        "ancestor_context = []\n"
        "for directory in cwd.parents:\n"
        "    for name in ('AGENTS.md', 'opencode.json', 'opencode.jsonc', '.git', '.opencode/AGENTS.md', '.opencode/opencode.json', '.opencode/opencode.jsonc', '.opencode/agents'):\n"
        "        if (directory / name).exists() or (directory / name).is_symlink():\n"
        "            ancestor_context.append(str(directory / name))\n"
        "payload = {\n"
        "    'cwd': str(cwd),\n"
        "    'ancestor_context': ancestor_context,\n"
        "    'arguments': sys.argv[1:],\n"
        "    'config_dir': os.environ.get('OPENCODE_CONFIG_DIR'),\n"
        "    'config_override': os.environ.get('OPENCODE_CONFIG'),\n"
        "    'config_content': os.environ.get('OPENCODE_CONFIG_CONTENT'),\n"
        "    'disable_project_config': os.environ.get('OPENCODE_DISABLE_PROJECT_CONFIG'),\n"
        "    'project_config': json.loads((cwd / 'opencode.json').read_text(encoding='utf-8')),\n"
        "    'agent_exists': (cwd / '.opencode/agents/chatgpt-private.md').is_file(),\n"
        "}\n"
        f"Path({str(call_log)!r}).write_text(json.dumps(payload), encoding='utf-8')\n"
        "print(json.dumps(payload))\n",
        encoding="utf-8",
    )
    path.chmod(0o700)


def run_launcher(cwd: Path, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    """Run the launcher with bounded output and execution time."""
    return subprocess.run(
        [str(LAUNCHER)],
        cwd=cwd,
        env=env,
        text=True,
        capture_output=True,
        check=False,
        timeout=30,
    )


def test_agent_permissions() -> None:
    """Allow only direct ChatGPT chat/search actions and deny all other tools."""
    rules = parse_rules(AGENT.read_text(encoding="utf-8"))
    assert rules == [
        PermissionRule("*", "*", "deny"),
        PermissionRule("chatgpt_chat", "*", "allow"),
        PermissionRule("chatgpt_web_search", "*", "allow"),
    ]
    for allowed_action in ("chatgpt_chat", "chatgpt_web_search"):
        assert permission_effect(rules, allowed_action) == "allow", allowed_action

    denied_actions = (
        "execute",
        "read",
        "glob",
        "grep",
        "edit",
        "write",
        "patch",
        "shell",
        "skill",
        "webfetch",
        "websearch",
        "subagent",
        "question",
        "github_get_me",
        "browser_tabs_open",
        "playwright_browser_navigate",
        "chatgpt_generate_image",
    )
    for denied_action in denied_actions:
        assert permission_effect(rules, denied_action) == "deny", denied_action


def test_neutral_launch_and_rejections() -> None:
    """Launch outside a hostile project and reject inherited context or symlinks."""
    TMP_ROOT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="chatgpt-private-test-", dir=TMP_ROOT) as temporary:
        root = Path(temporary)
        home = root / "home"
        home.mkdir(mode=0o700)
        hostile_project = root / "repository"
        hostile_project.mkdir()
        (hostile_project / "AGENTS.md").write_text("untrusted project instruction\n", encoding="utf-8")
        (hostile_project / "opencode.json").write_text('{"project_marker":"must not load"}\n', encoding="utf-8")

        neutral = root / "neutral" / "chatgpt-private"
        profile = root / "profile"
        profile_config = profile / "config/opencode.jsonc"
        binary = root / "bin" / "opencode"
        call_log = root / "calls.json"
        default_binary = home / ".local/opt/opencode-v2/opencode"
        default_call_log = root / "default-calls.json"
        binary.parent.mkdir()
        make_stub_binary(binary, call_log)
        default_binary.parent.mkdir(parents=True)
        make_stub_binary(default_binary, default_call_log)
        profile_config.parent.mkdir(parents=True)
        profile_config.write_text('{"default_agent":"build"}\n', encoding="utf-8")

        env = os.environ.copy()
        env.update(
            HOME=str(home),
            OPENCODE_V2_BIN=str(binary),
            OPENCODE_V2_PILOT_DIR=str(profile),
            CHATGPT_PRIVATE_DIR=str(neutral),
            OPENCODE_CONFIG=str(hostile_project / "opencode.json"),
            OPENCODE_CONFIG_CONTENT='{"project_marker":"must not load"}',
            OPENCODE_DISABLE_PROJECT_CONFIG="1",
        )

        successful = run_launcher(hostile_project, env)
        assert successful.returncode == 0, f"private launch failed:\n{successful.stdout}\n{successful.stderr}"
        payload = json.loads(successful.stdout)
        assert Path(payload["cwd"]) == neutral
        assert hostile_project not in Path(payload["cwd"]).parents
        assert payload["ancestor_context"] == []
        assert payload["arguments"] == []
        assert payload["config_dir"] == str(profile / "config")
        assert payload["config_override"] is None
        assert payload["config_content"] is None
        assert payload["disable_project_config"] is None
        assert payload["project_config"]["default_agent"] == "chatgpt-private"
        assert payload["agent_exists"] is True
        assert profile_config.read_text(encoding="utf-8") == '{"default_agent":"build"}\n'
        assert (hostile_project / "AGENTS.md").read_text(encoding="utf-8") == "untrusted project instruction\n"
        assert stat.S_IMODE(neutral.stat().st_mode) == 0o700
        assert stat.S_IMODE((neutral / "opencode.json").stat().st_mode) == 0o600
        assert stat.S_IMODE((neutral / ".opencode/agents/chatgpt-private.md").stat().st_mode) == 0o600

        call_log.unlink()
        default_env = dict(env)
        default_env.pop("OPENCODE_V2_BIN")
        default_binary_launch = run_launcher(hostile_project, default_env)
        assert default_binary_launch.returncode == 0, (
            f"default active binary launch failed:\n"
            f"{default_binary_launch.stdout}\n{default_binary_launch.stderr}"
        )
        default_payload = json.loads(default_binary_launch.stdout)
        assert Path(default_payload["cwd"]) == neutral
        assert default_payload["project_config"]["default_agent"] == "chatgpt-private"
        assert default_payload["agent_exists"] is True
        assert default_call_log.exists()
        default_call_log.unlink()

        nested_neutral = hostile_project / "private-workspace"
        inherited_context = run_launcher(
            hostile_project,
            dict(env, CHATGPT_PRIVATE_DIR=str(nested_neutral)),
        )
        assert inherited_context.returncode != 0
        assert "project context" in inherited_context.stderr
        assert not call_log.exists()
        assert not nested_neutral.exists()

        symlink_target = root / "symlink-target"
        symlink = root / "neutral-link"
        symlink_target.mkdir()
        symlink.symlink_to(symlink_target, target_is_directory=True)
        symlink_launch = run_launcher(
            hostile_project,
            dict(env, CHATGPT_PRIVATE_DIR=str(symlink)),
        )
        assert symlink_launch.returncode != 0
        assert "symlink" in symlink_launch.stderr
        assert not call_log.exists()


def main() -> None:
    """Run the focused positive and negative checks."""
    test_agent_permissions()
    test_neutral_launch_and_rejections()
    print("OK: private ChatGPT permissions and neutral launcher checks passed")


if __name__ == "__main__":
    main()
