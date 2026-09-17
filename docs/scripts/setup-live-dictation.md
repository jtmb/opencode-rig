# `setup-live-dictation.sh`

Optional local, incremental Vosk dictation for GNOME Wayland. It types partial
hypotheses and corrections into the focused field on `Alt+X`, and `Alt+X` again
suspends recognition and closes the microphone stream. The service stays
suspended in memory for fast reuse and is deliberately disabled at login.

Provision the computer-use stack first (for `ydotool` and its input access),
then run this script.

```bash
./platforms/linux/ubuntu/computer-use/scripts/setup-live-dictation.sh --verify-only
./platforms/linux/ubuntu/computer-use/scripts/setup-live-dictation.sh --apply
./platforms/linux/ubuntu/computer-use/scripts/setup-live-dictation.sh --verify-only
```

## Options

| Option | Default | Effect |
|--------|---------|--------|
| `--verify-only` | yes | Check the installation without changing it |
| `--apply` | — | Install or repair the user-space setup |
| `--audio-source NAME` | current default source | PipeWire source node name passed to `pw-cat` |
| `--alsa-card NUMBER` | `0` | ALSA card containing the `Mic Boost` control |
| `--mic-boost-percent VALUE` | `33` | `Mic Boost` mixer percentage, 0–100 |

The default audio source is detected with
`wpctl inspect @DEFAULT_AUDIO_SOURCE@` and the `node.name` line. Hardware values
are overridable because the defaults are tuned for the reference i5-6200U /
ALC255 machine.

## Pinned artifacts

Every downloaded artifact is checksum-verified before use.

| Artifact | Pin |
|----------|-----|
| `nerd-dictation` script | commit `41f372789c640e01bb6650339a78312661530843`, SHA-256 `9e7825…4d10d` |
| Patched `nerd-dictation` | SHA-256 `6ebe4d…b56d2` (asserted after patching) |
| Vosk wheel | `vosk==0.3.45`, SHA-256 `25e025…6619f` |
| Vosk model | `vosk-model-small-en-us-0.15`, SHA-256 `30f262…42498` |

The Python dependencies installed beside the wheel are pinned to exact versions
(`certifi`, `cffi`, `charset-normalizer`, `idna`, `pycparser`, `requests`,
`srt`, `tqdm`, `urllib3`, `websockets`).

## Installed paths

| Item | Path |
|------|------|
| Data root | `~/.local/share/nerd-dictation/` |
| Python venv | `~/.local/share/nerd-dictation/venv/` |
| Engine | `~/.local/share/nerd-dictation/nerd-dictation` |
| Model | `~/.local/share/nerd-dictation/models/small-en-us-0.15/` |
| Active model link | `~/.local/share/nerd-dictation/model` |
| Config | `~/.config/nerd-dictation/nerd-dictation.py` |
| Shortcut backup | `~/.config/nerd-dictation/shortcut-backup.txt` |
| Toggle wrapper | `~/.local/bin/live-dictation-toggle` |
| User service | `~/.config/systemd/user/live-dictation.service` |
| GNOME shortcut | `…/custom-keybindings/handy/` bound to `<Alt>x` |

## Flow

### 1. Input validation

`validate_inputs()` requires x86_64 (the pinned Vosk wheel is x86_64 only),
numeric `--alsa-card`, and an integer `--mic-boost-percent` in 0–100. It
resolves the audio source when not supplied and rejects a source name that does
not match `^[A-Za-z0-9_.:-]+$`, so the generated unit cannot contain shell
metacharacters. `check_commands()` requires `amixer`, `awk`, `cmp`, `curl`,
`flock`, `gsettings`, `install`, `pw-cat`, `python3`, `sha256sum`, `systemctl`,
`unzip`, `wpctl`, `ydotool`, and Python venv support.

### 2. Python runtime

`install_python_runtime()` reuses the venv when its `vosk` version equals
`0.3.45` and its recorded wheel SHA-256 marker matches. Otherwise it:

1. Downloads and verifies the wheel (`download_verified` uses
   `curl -fL --retry 3 --proto '=https' --tlsv1.2` and
   `sha256sum --check --strict`).
2. Moves any existing venv to `venv.backup`.
3. Creates a fresh venv and installs the pinned dependencies plus the wheel.
4. On failure, removes the partial venv and restores the backup, then fails.
5. On success, writes `.vosk-wheel-sha256` and removes the backup.

### 3. Engine

`install_engine()` reuses the engine when its SHA-256 equals the patched hash.
Otherwise it downloads the pinned commit and applies `patch_nerd_dictation()`,
which makes exactly two replacements:

- Replace the old `type --next-delay 5` invocation with
  `type --key-delay 1 --key-hold 1`, so both ydotool delays are set (the
  original `--next-delay` only affected separate command-line strings and left
  the 20 ms per-key defaults unchanged).
- Add `--target <pulse-device-name>` to the `pw-cat` argument list when a device
  is known.

The patch asserts the original context appears exactly once; if upstream source
no longer matches, the script refuses rather than applying a wrong patch. The
patched file is then hash-checked and installed `0755`.

### 4. Model

`install_model()` reuses the model when `am/final.mdl` exists and the archive
hash marker matches. Otherwise it downloads the model zip, verifies the hash,
rejects any archive entry that is not under the model name, extracts, checks
`am/final.mdl`, replaces the model directory, and records the marker. It then
refreshes the `model` symlink to the model directory.

### 5. Configuration, toggle, and service

`install_config()` writes three files through `write_file()`, which stages the
content, compares to the target, fixes the mode if needed, and otherwise writes
atomically via `install -D -m`:

- **Punctuation config** (`nerd-dictation.py`): phrase replacements
  ("question mark" → `?`, "period" → `.`, etc.) and word replacements
  (`i` → `I`, `linux` → `Linux`, `ubuntu` → `Ubuntu`).
- **Toggle wrapper** (`live-dictation-toggle`): a locked script that reads the
  service's main PID and the cookie file. If the service is running with a
  matching cookie, it either `resume`s (process state `T`) or `suspend`s (after
  a 150 ms delay so GNOME releases the `Alt+X` keys). It guards a cold start by
  waiting if the process is younger than 3 s. If the service is not running, it
  stops/resets and starts the unit.
- **User service** (`live-dictation.service`): `Type=simple`, depends on
  `ydotool.service` and `pipewire.service`, runs an `ExecStartPre` that sets
  `Mic Boost`, and starts `nerd-dictation begin` with the cookie, config, model,
  `--input=PW-CAT`, the detected pulse device, `--full-sentence`, and
  `--simulate-input-tool=YDOTOOL`. It is `Restart=no`, has
  `TimeoutStopSec=3`, and removes the cookie on stop.

`apply_setup()` then sets `Mic Boost` with `amixer`, reloads the user daemon,
disables the service at login, and installs the shortcut.

### 6. GNOME shortcut

`install_shortcut()`:

- Backs up the previous name/command/binding to `shortcut-backup.txt` before
  changing anything, unless the shortcut already points at our toggle or the
  backup already exists.
- Sets name `Live Dictation (Vosk)`, command to the toggle wrapper, and binding
  `<Alt>x`.
- Parses the `custom-keybindings` list and appends our shortcut path if absent.

## Verification

`verify()` is read-only and checks:

- The patched engine exists, is executable, and matches the patched SHA-256.
- The venv's Vosk version and wheel marker match the pins.
- The model files, marker, and active symlink match.
- The toggle wrapper is executable and passes `bash -n`.
- The config module imports and transforms
  `"i use ubuntu comma linux too"` to `"I use Ubuntu, Linux too"`.
- The unit passes `systemd-analyze --user verify` and contains the expected
  audio source and `Mic Boost` value.
- The service is **disabled** at login.
- `ydotool.service` is active and its private socket exists.
- The GNOME shortcut name, command, binding, and registration match.
- ALSA `Mic Boost` is at the configured percentage.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Verification passed (or apply + verify passed) |
| `1` | One or more verification checks failed, or validation/installation failed |
| `2` | Invalid arguments |

## Safety and rollback

- The script manages only user-owned files and the existing GNOME shortcut; it
  performs no APT, group, or permission changes and writes no login autostart.
- All downloads are HTTPS with a pinned SHA-256 checked with `--strict`.
- A failed venv build restores the previous runtime.
- The toggle is locked with `flock` so a double press cannot race.
- `shortcut-backup.txt` records the previous shortcut so the user's prior
  binding (for example a Handy installation) can be restored. See the
  component README for the exact restore commands.

## Notes and limitations

- x86_64 only.
- `Alt+X` is a global GNOME custom shortcut; applying the setup overwrites the
  shortcut at the same keybinding path and saves the previous values first.
- The service is intentionally not enabled at login and exits with the user
  session.
- Tuning (audio source, ALSA card, Mic Boost) is hardware-specific; override
  the options on different hardware.
