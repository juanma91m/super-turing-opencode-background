#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
WORKSPACE_DIR="$(CDPATH= cd -- "$REPO_DIR/.." && pwd)"
TARGET_DIR="${HOME}/.config/opencode"
INSTALL_ROOT="${HOME}/.opencode"
OPENCODE_ROOT=""
BUN_PATH=""
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: bash scripts/install.sh [options]

Stable distribution installer for the complete Background addon. On a fresh
supported Linux x64 installation it prepares the pinned OpenCode source
checkout, installs the addon/patch and adopts ~/.opencode as a managed install.

Options:
  --target-dir <path>       Must be ~/.config/opencode for the full Background lifecycle
  --workspace-dir <path>    Parent for the managed OpenCode source checkout
  --opencode-root <path>    Use an existing clean compatible source checkout
  --install-root <path>     Local OpenCode install root (default: ~/.opencode)
  --bun-path <path>         Bun executable used to build the managed runtime
  --dry-run                 Validate/report without changing the installation
  -h, --help                Show this help
EOF
}

log() { printf '[background-install] %s\n' "$*"; }

manifest_value() {
  python3 - "$REPO_DIR/manifest/addon.json" "$1" <<'PY'
import json
import pathlib
import sys

value = json.loads(pathlib.Path(sys.argv[1]).read_text())
for part in sys.argv[2].split('.'):
    value = value[part]
print(value)
PY
}

installed_is_healthy() {
  local status_file
  status_file="$(mktemp)"
  if ! node "$REPO_DIR/scripts/status.mjs" --install-root "$INSTALL_ROOT" --json >"$status_file" 2>/dev/null; then
    rm -f "$status_file"
    return 1
  fi
  if python3 - "$status_file" <<'PY'
import json
import pathlib
import sys

data = json.loads(pathlib.Path(sys.argv[1]).read_text())
managed = data.get("managedLocalInstall") or {}
plugins = data.get("plugins") or []
assets = data.get("assets") or []
healthy = (
    managed.get("health") == "adopted"
    and not managed.get("problems")
    and all((item.get("status") or {}).get("state") == "installed" for item in plugins)
    and all((item.get("status") or {}).get("state") == "installed" for item in assets)
)
raise SystemExit(0 if healthy else 1)
PY
  then
    rm -f "$status_file"
    return 0
  fi
  rm -f "$status_file"
  return 1
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --target-dir) TARGET_DIR="$2"; shift 2 ;;
    --workspace-dir) WORKSPACE_DIR="$2"; shift 2 ;;
    --opencode-root) OPENCODE_ROOT="$2"; shift 2 ;;
    --install-root) INSTALL_ROOT="$2"; shift 2 ;;
    --bun-path) BUN_PATH="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

for dependency in python3 node git; do
  command -v "$dependency" >/dev/null 2>&1 || { printf '%s is required\n' "$dependency" >&2; exit 1; }
done

if [[ "$(realpath -m "$TARGET_DIR")" != "$(realpath -m "$HOME/.config/opencode")" ]]; then
  printf 'Background full install only supports the active target: %s\n' "$HOME/.config/opencode" >&2
  exit 2
fi

if installed_is_healthy; then
  log "Background managed install is already healthy in $INSTALL_ROOT"
  exit 0
fi

opencode_version="$(manifest_value distribution.preferredOpenCodeVersion)"
source_repository="$(manifest_value distribution.sourceRepository)"
if [[ -z "$OPENCODE_ROOT" ]]; then
  OPENCODE_ROOT="$WORKSPACE_DIR/opencode-background-source-$opencode_version"
fi

if [[ -z "$BUN_PATH" ]]; then
  BUN_PATH="$(command -v bun || true)"
fi
[[ -n "$BUN_PATH" && -x "$BUN_PATH" ]] || {
  printf 'A Bun executable is required; install bun or pass --bun-path\n' >&2
  exit 1
}

if [[ ! -e "$OPENCODE_ROOT" ]]; then
  if [[ "$DRY_RUN" -eq 1 ]]; then
    log "Dry-run: would clone $source_repository tag v$opencode_version into $OPENCODE_ROOT"
    log "Dry-run: would enable the addon and adopt $INSTALL_ROOT"
    exit 0
  fi
  log "Cloning OpenCode v$opencode_version into $OPENCODE_ROOT"
  mkdir -p "$(dirname -- "$OPENCODE_ROOT")"
  git clone --depth 1 --branch "v$opencode_version" "$source_repository" "$OPENCODE_ROOT"
fi

[[ -d "$OPENCODE_ROOT/.git" ]] || { printf 'OpenCode source path is not a Git checkout: %s\n' "$OPENCODE_ROOT" >&2; exit 1; }
actual_version="$(python3 - "$OPENCODE_ROOT/packages/opencode/package.json" <<'PY'
import json
import pathlib
import sys
print(json.loads(pathlib.Path(sys.argv[1]).read_text())["version"])
PY
)"
[[ "$actual_version" == "$opencode_version" ]] || {
  printf 'OpenCode source version mismatch: expected %s, got %s\n' "$opencode_version" "$actual_version" >&2
  exit 1
}
[[ -z "$(git -C "$OPENCODE_ROOT" status --porcelain)" ]] || {
  printf 'OpenCode source checkout is not clean: %s\n' "$OPENCODE_ROOT" >&2
  printf 'Use a fresh checkout or inspect the existing Background lifecycle state before retrying.\n' >&2
  exit 1
}

enable_args=(--opencode-root "$OPENCODE_ROOT")
adopt_args=(--checkout-root "$OPENCODE_ROOT" --install-root "$INSTALL_ROOT" --bun-path "$BUN_PATH")
[[ "$DRY_RUN" -eq 1 ]] && enable_args+=(--dry-run) && adopt_args+=(--dry-run)

log "Preparing Background addon on OpenCode v$opencode_version"
node "$REPO_DIR/scripts/enable.mjs" "${enable_args[@]}"
log "Adopting local OpenCode installation in $INSTALL_ROOT"
node "$REPO_DIR/scripts/adopt-local-install.mjs" "${adopt_args[@]}"

if [[ "$DRY_RUN" -eq 0 ]]; then
  installed_is_healthy || { printf 'Background post-install status is not healthy\n' >&2; exit 1; }
fi
log 'Background addon installation finished'
