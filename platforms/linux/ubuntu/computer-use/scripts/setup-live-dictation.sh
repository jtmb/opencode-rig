#!/usr/bin/env bash
# Install and verify local incremental Vosk dictation for GNOME Wayland.
#
# This script manages only user-owned files and an existing GNOME shortcut.
# Provision ydotool and its input permissions separately with
# setup-computer-assistant.sh before applying this setup.
set -euo pipefail

APPLY=0
MODE_SET=0
AUDIO_SOURCE=""
ALSA_CARD=0
MIC_BOOST_PERCENT=33

usage() {
  cat <<'EOF'
Usage: setup-live-dictation.sh [--verify-only|--apply] [options]

Options:
  --verify-only              Check the installation without changing it (default)
  --apply                    Install or repair the user-space setup
  --audio-source NAME        PipeWire source node name (default: current audio source)
  --alsa-card NUMBER         ALSA card containing Mic Boost (default: 0)
  --mic-boost-percent VALUE  Mic Boost mixer percentage, 0-100 (default: 33)
  -h, --help                 Show this help

The generated service is deliberately disabled at login. Alt+X starts it on
demand; another Alt+X suspends recognition and closes microphone capture.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply)
      [ "$MODE_SET" -eq 0 ] || { usage >&2; exit 2; }
      APPLY=1
      MODE_SET=1
      ;;
    --verify-only)
      [ "$MODE_SET" -eq 0 ] || { usage >&2; exit 2; }
      APPLY=0
      MODE_SET=1
      ;;
    --audio-source)
      [ "$#" -ge 2 ] || { echo "--audio-source requires a value" >&2; exit 2; }
      AUDIO_SOURCE="$2"
      shift
      ;;
    --audio-source=*)
      AUDIO_SOURCE="${1#*=}"
      ;;
    --alsa-card)
      [ "$#" -ge 2 ] || { echo "--alsa-card requires a value" >&2; exit 2; }
      ALSA_CARD="$2"
      shift
      ;;
    --alsa-card=*)
      ALSA_CARD="${1#*=}"
      ;;
    --mic-boost-percent)
      [ "$#" -ge 2 ] || { echo "--mic-boost-percent requires a value" >&2; exit 2; }
      MIC_BOOST_PERCENT="$2"
      shift
      ;;
    --mic-boost-percent=*)
      MIC_BOOST_PERCENT="${1#*=}"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
  shift
done

readonly NERD_COMMIT="41f372789c640e01bb6650339a78312661530843"
readonly NERD_SHA256="9e782539337affde7c858eaf6f9b173d429a86434b6392ed11ad862de294d10d"
readonly NERD_PATCHED_SHA256="6ebe4d5b42c6d8e4dd5f59f698b1f46d690863be9d08ab734e82082b188b56d2"
readonly NERD_URL="https://raw.githubusercontent.com/ideasman42/nerd-dictation/${NERD_COMMIT}/nerd-dictation"
readonly MODEL_NAME="vosk-model-small-en-us-0.15"
readonly MODEL_SHA256="30f26242c4eb449f948e42cb302dd7a686cb29a3423a8367f99ff41780942498"
readonly MODEL_URL="https://alphacephei.com/vosk/models/${MODEL_NAME}.zip"
readonly VOSK_VERSION="0.3.45"
readonly VOSK_WHEEL="vosk-0.3.45-py3-none-manylinux_2_12_x86_64.manylinux2010_x86_64.whl"
readonly VOSK_SHA256="25e025093c4399d7278f543568ed8cc5460ac3a4bf48c23673ace1e25d26619f"
readonly VOSK_URL="https://files.pythonhosted.org/packages/fc/ca/83398cfcd557360a3d7b2d732aee1c5f6999f68618d1645f38d53e14c9ff/${VOSK_WHEEL}"

readonly DATA_DIR="$HOME/.local/share/nerd-dictation"
readonly VENV_DIR="$DATA_DIR/venv"
readonly DICTATION="$DATA_DIR/nerd-dictation"
readonly MODELS_DIR="$DATA_DIR/models"
readonly MODEL_DIR="$MODELS_DIR/small-en-us-0.15"
readonly MODEL_LINK="$DATA_DIR/model"
readonly CONFIG_DIR="$HOME/.config/nerd-dictation"
readonly CONFIG_FILE="$CONFIG_DIR/nerd-dictation.py"
readonly SHORTCUT_BACKUP="$CONFIG_DIR/shortcut-backup.txt"
readonly TOGGLE="$HOME/.local/bin/live-dictation-toggle"
readonly UNIT="$HOME/.config/systemd/user/live-dictation.service"
readonly SHORTCUT_PATH="/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/handy/"
readonly SHORTCUT_SCHEMA="org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:${SHORTCUT_PATH}"
readonly MEDIA_KEYS_SCHEMA="org.gnome.settings-daemon.plugins.media-keys"
readonly SOCKET="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/.ydotool_socket"

TEMP_DIR=""

ok() { echo "OK: $*"; }
fail() { echo "MISSING/FAILED: $*" >&2; }

cleanup() {
  if [ -n "$TEMP_DIR" ] && [ -d "$TEMP_DIR" ]; then
    rm -rf "$TEMP_DIR"
  fi
}
trap cleanup EXIT

detect_audio_source() {
  wpctl inspect @DEFAULT_AUDIO_SOURCE@ 2>/dev/null |
    awk -F'"' '/node.name =/ { print $2; exit }'
}

validate_inputs() {
  if [ "$(uname -m)" != "x86_64" ]; then
    fail "this pinned Vosk wheel supports x86_64 only"
    return 1
  fi
  if ! [[ "$ALSA_CARD" =~ ^[0-9]+$ ]]; then
    fail "ALSA card must be a non-negative integer"
    return 1
  fi
  if ! [[ "$MIC_BOOST_PERCENT" =~ ^[0-9]+$ ]] ||
     [ "$MIC_BOOST_PERCENT" -gt 100 ]; then
    fail "Mic Boost percentage must be an integer from 0 to 100"
    return 1
  fi
  if [ -z "$AUDIO_SOURCE" ]; then
    AUDIO_SOURCE="$(detect_audio_source)"
  fi
  if ! [[ "$AUDIO_SOURCE" =~ ^[A-Za-z0-9_.:-]+$ ]]; then
    fail "could not determine a safe PipeWire audio source node name"
    return 1
  fi
}

check_commands() {
  local status=0
  local command
  local required=(amixer awk cmp curl flock gsettings install pw-cat python3 sha256sum systemctl unzip wpctl ydotool)
  for command in "${required[@]}"; do
    if ! command -v "$command" >/dev/null 2>&1; then
      fail "required command $command"
      status=1
    fi
  done
  if ! python3 -m venv --help >/dev/null 2>&1; then
    fail "Python venv support"
    status=1
  fi
  if [ "$status" -ne 0 ]; then
    fail "provision Ubuntu dependencies and ydotool with setup-computer-assistant.sh --apply"
  fi
  return "$status"
}

write_file() {
  local target="$1"
  local mode="$2"
  local staged
  staged="$(mktemp "$TEMP_DIR/write.XXXXXX")"
  cat > "$staged"
  if [ -f "$target" ] && cmp -s "$staged" "$target"; then
    rm -f "$staged"
    if [ "$(stat -c %a "$target")" != "${mode#0}" ]; then
      chmod "$mode" "$target"
    fi
    return
  fi
  install -D -m "$mode" "$staged" "$target"
  rm -f "$staged"
}

download_verified() {
  local url="$1"
  local expected="$2"
  local output="$3"
  curl -fL --retry 3 --proto '=https' --tlsv1.2 "$url" -o "$output"
  printf '%s  %s\n' "$expected" "$output" | sha256sum --check --strict
}

parse_gsettings_list() {
  python3 -c '
import ast
import sys

raw = sys.stdin.read().strip()
if raw.startswith("@as "):
    raw = raw[len("@as "):].strip()
values = ast.literal_eval(raw)
if not isinstance(values, list) or any(not isinstance(item, str) for item in values):
    raise SystemExit(1)
print(repr(values))
'
}

patch_nerd_dictation() {
  local source="$1"
  python3 - "$source" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
replacements = (
    (
        '''    # The low delay value makes typing fast, making the output much snappier
    # than the slow default.
    run_command_or_exit_on_failure(
        [
            cmd,
            "type",
            "--next-delay",
            "5",
            "--",
            text,
        ]
    )''',
        '''    # Set both current ydotool delays; --next-delay only affects separate
    # command-line strings and leaves the 20ms per-key defaults unchanged.
    run_command_or_exit_on_failure(
        [
            cmd,
            "type",
            "--key-delay",
            "1",
            "--key-hold",
            "1",
            "--",
            text,
        ]
    )''',
    ),
    (
        '''            "--rate",
            str(sample_rate),
            "--channels=1",
            "-",
        )''',
        '''            "--rate",
            str(sample_rate),
            "--channels=1",
            *(("--target", pulse_device_name) if pulse_device_name else ()),
            "-",
        )''',
    ),
)
for old, new in replacements:
    if text.count(old) != 1:
        raise SystemExit("pinned nerd-dictation source no longer matches the expected patch context")
    text = text.replace(old, new)
path.write_text(text, encoding="utf-8")
PY
  printf '%s  %s\n' "$NERD_PATCHED_SHA256" "$source" | sha256sum --check --strict
}

install_python_runtime() {
  local wheel="$TEMP_DIR/$VOSK_WHEEL"
  local backup="$VENV_DIR.backup"
  if [ -x "$VENV_DIR/bin/python" ] &&
     [ "$("$VENV_DIR/bin/python" -c 'import importlib.metadata; print(importlib.metadata.version("vosk"))' 2>/dev/null || true)" = "$VOSK_VERSION" ] &&
     [ "$(cat "$VENV_DIR/.vosk-wheel-sha256" 2>/dev/null || true)" = "$VOSK_SHA256" ]; then
    ok "Vosk $VOSK_VERSION virtual environment"
    return
  fi

  download_verified "$VOSK_URL" "$VOSK_SHA256" "$wheel"
  rm -rf "$backup"
  if [ -d "$VENV_DIR" ]; then
    mv "$VENV_DIR" "$backup"
  fi
  if ! python3 -m venv "$VENV_DIR" ||
     ! "$VENV_DIR/bin/python" -m pip install --disable-pip-version-check \
       certifi==2026.7.22 \
       cffi==2.1.1 \
       charset-normalizer==3.5.1 \
       idna==3.19 \
       pycparser==3.0 \
       requests==2.34.2 \
       srt==3.5.3 \
       tqdm==4.70.1 \
       urllib3==2.7.0 \
       websockets==17.1 \
       "$wheel"; then
    rm -rf "$VENV_DIR"
    if [ -d "$backup" ]; then
      mv "$backup" "$VENV_DIR"
    fi
    fail "could not build the isolated Vosk runtime; restored the previous runtime"
    return 1
  fi
  printf '%s\n' "$VOSK_SHA256" > "$VENV_DIR/.vosk-wheel-sha256"
  rm -rf "$backup"
}

install_engine() {
  local source="$TEMP_DIR/nerd-dictation"
  if [ "$(sha256sum "$DICTATION" 2>/dev/null | awk '{print $1}')" = "$NERD_PATCHED_SHA256" ]; then
    ok "patched nerd-dictation $NERD_COMMIT"
    return
  fi
  download_verified "$NERD_URL" "$NERD_SHA256" "$source"
  patch_nerd_dictation "$source"
  install -D -m 0755 "$source" "$DICTATION"
}

install_model() {
  local archive="$TEMP_DIR/${MODEL_NAME}.zip"
  local extract="$TEMP_DIR/model"
  local entry
  if [ -f "$MODEL_DIR/am/final.mdl" ] &&
     [ "$(cat "$MODEL_DIR/.archive-sha256" 2>/dev/null || true)" = "$MODEL_SHA256" ]; then
    ok "$MODEL_NAME"
  else
    download_verified "$MODEL_URL" "$MODEL_SHA256" "$archive"
    while IFS= read -r entry; do
      case "$entry" in
        "$MODEL_NAME"/*) ;;
        *) fail "unsafe model archive entry: $entry"; return 1 ;;
      esac
    done < <(unzip -Z1 "$archive")
    mkdir -p "$extract"
    unzip -q "$archive" -d "$extract"
    test -f "$extract/$MODEL_NAME/am/final.mdl"
    rm -rf "$MODEL_DIR"
    mv "$extract/$MODEL_NAME" "$MODEL_DIR"
    printf '%s\n' "$MODEL_SHA256" > "$MODEL_DIR/.archive-sha256"
  fi
  ln -sfn "models/small-en-us-0.15" "$MODEL_LINK"
}

install_config() {
  write_file "$CONFIG_FILE" 0644 <<'PY'
import re


PHRASE_REPLACEMENTS = (
    (re.compile(r"(?:^|\s+)question mark\b"), "?"),
    (re.compile(r"(?:^|\s+)exclamation (?:mark|point)\b"), "!"),
    (re.compile(r"(?:^|\s+)period\b"), "."),
    (re.compile(r"(?:^|\s+)comma\b"), ","),
    (re.compile(r"(?:^|\s+)colon\b"), ":"),
    (re.compile(r"(?:^|\s+)semicolon\b"), ";"),
)

WORD_REPLACEMENTS = {
    "i": "I",
    "i'm": "I'm",
    "i've": "I've",
    "i'll": "I'll",
    "i'd": "I'd",
    "linux": "Linux",
    "ubuntu": "Ubuntu",
}


def nerd_dictation_process(text):
    words = text.split(" ")
    text = " ".join(WORD_REPLACEMENTS.get(word, word) for word in words)

    for pattern, replacement in PHRASE_REPLACEMENTS:
        text = pattern.sub(replacement, text)

    return text
PY

  write_file "$TOGGLE" 0755 <<'BASH'
#!/usr/bin/env bash
set -euo pipefail

unit="live-dictation.service"
runtime_dir="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/live-dictation"
cookie="${runtime_dir}/nerd-dictation.cookie"
python="${HOME}/.local/share/nerd-dictation/venv/bin/python"
dictation="${HOME}/.local/share/nerd-dictation/nerd-dictation"

exec 9>"${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/live-dictation-toggle.lock"
flock -n 9 || exit 0

main_pid="$(systemctl --user show "$unit" --property=MainPID --value 2>/dev/null || true)"
cookie_pid=""
if [[ -r "$cookie" ]]; then
    read -r cookie_pid < "$cookie" || true
fi

if [[ "$main_pid" =~ ^[1-9][0-9]*$ && "$cookie_pid" == "$main_pid" && -r "/proc/${main_pid}/stat" ]]; then
    # The cookie exists before Vosk finishes loading and installs its signal
    # handlers. Avoid terminating a cold start if the shortcut is tapped twice.
    elapsed="$(ps -o etimes= -p "$main_pid" | tr -d ' ')"
    if [[ "$elapsed" =~ ^[0-9]+$ && "$elapsed" -lt 3 ]]; then
        sleep "$((3 - elapsed))"
        current_pid="$(systemctl --user show "$unit" --property=MainPID --value 2>/dev/null || true)"
        [[ "$current_pid" == "$main_pid" && -r "/proc/${main_pid}/stat" ]] || exit 0
    fi

    state="$(ps -o stat= -p "$main_pid")"
    if [[ "$state" == T* ]]; then
        "$python" "$dictation" resume --cookie="$cookie"
    else
        # Let GNOME release the Alt+X keys before final correction events.
        sleep 0.15
        "$python" "$dictation" suspend --cookie="$cookie"
    fi
    exit 0
fi

systemctl --user stop "$unit" >/dev/null 2>&1 || true
systemctl --user reset-failed "$unit" >/dev/null 2>&1 || true
systemctl --user start "$unit"
BASH

  write_file "$UNIT" 0644 <<EOF
[Unit]
Description=Local live Vosk dictation
Wants=ydotool.service
After=ydotool.service pipewire.service

[Service]
Type=simple
RuntimeDirectory=live-dictation
RuntimeDirectoryMode=0700
ExecStartPre=/usr/bin/amixer -q -c $ALSA_CARD sset "Mic Boost" $MIC_BOOST_PERCENT%
ExecStart=%h/.local/share/nerd-dictation/venv/bin/python %h/.local/share/nerd-dictation/nerd-dictation begin --cookie=%t/live-dictation/nerd-dictation.cookie --config=%h/.config/nerd-dictation/nerd-dictation.py --vosk-model-dir=%h/.local/share/nerd-dictation/model --sample-rate=16000 --input=PW-CAT --pulse-device-name=$AUDIO_SOURCE --idle-time=0.05 --full-sentence --simulate-input-tool=YDOTOOL --verbose=1
ExecStopPost=/usr/bin/rm -f %t/live-dictation/nerd-dictation.cookie
Restart=no
TimeoutStopSec=3

[Install]
WantedBy=default.target
EOF
}

install_shortcut() {
  local current_command
  local paths
  local updated_paths
  current_command="$(gsettings get "$SHORTCUT_SCHEMA" command)"
  if [ "$current_command" != "'$TOGGLE'" ] &&
     [ "$current_command" != "''" ] &&
     [ ! -f "$SHORTCUT_BACKUP" ]; then
    write_file "$SHORTCUT_BACKUP" 0600 <<EOF
GNOME custom shortcut path: $SHORTCUT_PATH
Name: $(gsettings get "$SHORTCUT_SCHEMA" name)
Command: $current_command
Binding: $(gsettings get "$SHORTCUT_SCHEMA" binding)
EOF
  fi

  gsettings set "$SHORTCUT_SCHEMA" name "Live Dictation (Vosk)"
  gsettings set "$SHORTCUT_SCHEMA" command "$TOGGLE"
  gsettings set "$SHORTCUT_SCHEMA" binding '<Alt>x'

  paths="$(gsettings get "$MEDIA_KEYS_SCHEMA" custom-keybindings)"
  parsed_paths="$(parse_gsettings_list <<< "$paths")"
  updated_paths="$(python3 -c '
import ast
import sys

paths = ast.literal_eval(sys.stdin.read())
path = sys.argv[1]
if path not in paths:
    paths.append(path)
print(repr(paths))
' "$SHORTCUT_PATH" <<< "$parsed_paths")"
  gsettings set "$MEDIA_KEYS_SCHEMA" custom-keybindings "$updated_paths"
}

apply_setup() {
  TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/setup-live-dictation.XXXXXX")"
  systemctl --user stop live-dictation.service >/dev/null 2>&1 || true
  mkdir -p "$DATA_DIR" "$MODELS_DIR" "$CONFIG_DIR" "$HOME/.local/bin" "$HOME/.config/systemd/user"

  install_python_runtime
  install_engine
  install_model
  install_config
  amixer -q -c "$ALSA_CARD" sset "Mic Boost" "$MIC_BOOST_PERCENT%"
  systemctl --user daemon-reload
  systemctl --user disable live-dictation.service >/dev/null 2>&1 || true
  install_shortcut
}

verify() {
  local status=0
  local source_hash
  echo "=== live dictation verify ==="

  source_hash=""
  if [ -f "$DICTATION" ]; then
    source_hash="$(sha256sum "$DICTATION" 2>/dev/null | awk '{print $1}')"
  fi
  if [ "$source_hash" = "$NERD_PATCHED_SHA256" ] && [ -x "$DICTATION" ]; then
    ok "patched nerd-dictation $NERD_COMMIT"
  else
    fail "patched nerd-dictation executable"
    status=1
  fi

  if [ -x "$VENV_DIR/bin/python" ] &&
     [ "$("$VENV_DIR/bin/python" -c 'import importlib.metadata; print(importlib.metadata.version("vosk"))' 2>/dev/null || true)" = "$VOSK_VERSION" ] &&
     [ "$(cat "$VENV_DIR/.vosk-wheel-sha256" 2>/dev/null || true)" = "$VOSK_SHA256" ]; then
    ok "Vosk $VOSK_VERSION isolated runtime"
  else
    fail "Vosk $VOSK_VERSION isolated runtime"
    status=1
  fi

  if [ -f "$MODEL_DIR/am/final.mdl" ] &&
     [ "$(cat "$MODEL_DIR/.archive-sha256" 2>/dev/null || true)" = "$MODEL_SHA256" ] &&
     [ "$(readlink -f "$MODEL_LINK" 2>/dev/null || true)" = "$MODEL_DIR" ]; then
    ok "$MODEL_NAME and active model link"
  else
    fail "$MODEL_NAME and active model link"
    status=1
  fi

  if [ -x "$TOGGLE" ] && bash -n "$TOGGLE"; then
    ok "toggle wrapper $TOGGLE"
  else
    fail "toggle wrapper $TOGGLE"
    status=1
  fi

  if [ -f "$CONFIG_FILE" ] &&
     PYTHONDONTWRITEBYTECODE=1 "$VENV_DIR/bin/python" -c '
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("dictation_config", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
assert module.nerd_dictation_process("i use ubuntu comma linux too") == "I use Ubuntu, Linux too"
' "$CONFIG_FILE" 2>/dev/null; then
    ok "dictation punctuation configuration"
  else
    fail "dictation punctuation configuration"
    status=1
  fi

  if [ -f "$UNIT" ] &&
     systemd-analyze --user verify "$UNIT" >/dev/null 2>&1 &&
     grep -Fq -- "--pulse-device-name=$AUDIO_SOURCE" "$UNIT" &&
     grep -Fq -- "sset \"Mic Boost\" $MIC_BOOST_PERCENT%" "$UNIT"; then
    ok "user service targets $AUDIO_SOURCE"
  else
    fail "user service configuration for $AUDIO_SOURCE"
    status=1
  fi

  if systemctl --user is-enabled --quiet live-dictation.service; then
    fail "live-dictation.service is enabled at login"
    status=1
  else
    ok "live-dictation.service disabled at login"
  fi

  if systemctl --user is-active --quiet ydotool.service && [ -S "$SOCKET" ]; then
    ok "ydotool user service and private socket"
  else
    fail "ydotool user service/private socket; run setup-computer-assistant.sh --apply"
    status=1
  fi

  parsed_shortcuts=""
  if parsed_shortcuts="$(gsettings get "$MEDIA_KEYS_SCHEMA" custom-keybindings | parse_gsettings_list)"; then
    :
  else
    parsed_shortcuts=""
  fi
  if [ "$(gsettings get "$SHORTCUT_SCHEMA" name)" = "'Live Dictation (Vosk)'" ] &&
     [ "$(gsettings get "$SHORTCUT_SCHEMA" command)" = "'$TOGGLE'" ] &&
     [ "$(gsettings get "$SHORTCUT_SCHEMA" binding)" = "'<Alt>x'" ] &&
     python3 -c 'import ast,sys; raise SystemExit(0 if sys.argv[1] in ast.literal_eval(sys.stdin.read()) else 1)' "$SHORTCUT_PATH" <<< "$parsed_shortcuts"; then
    ok "GNOME Alt+X shortcut"
  else
    fail "GNOME Alt+X shortcut"
    status=1
  fi

  if amixer -c "$ALSA_CARD" sget "Mic Boost" 2>/dev/null |
       grep -Fq "[$MIC_BOOST_PERCENT%]"; then
    ok "Mic Boost calibrated to $MIC_BOOST_PERCENT%"
  else
    fail "Mic Boost is not $MIC_BOOST_PERCENT% on ALSA card $ALSA_CARD"
    status=1
  fi

  return "$status"
}

validate_inputs
check_commands

if [ "$APPLY" -eq 1 ]; then
  apply_setup
fi

verify

if [ "$APPLY" -eq 1 ]; then
  echo
  echo "Installed. Press Alt+X to start or suspend local dictation."
  echo "Rollback shortcut values are preserved in: $SHORTCUT_BACKUP"
fi
