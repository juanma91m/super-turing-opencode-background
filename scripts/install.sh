#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
WORKSPACE_DIR="$(CDPATH= cd -- "$REPO_DIR/.." && pwd)"
TARGET_DIR="${HOME}/.config/opencode"
INSTALL_ROOT="${HOME}/.opencode"
OPENCODE_ROOT=""
BUN_PATH=""
BUN_RUNTIME_DIR="${HOME}/.local/share/super-turing-opencode-background/runtime"
DRY_RUN=0
PREFLIGHT_ONLY=0

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
  --bun-runtime-dir <path>  Managed Bun runtime root used when Bun is missing
  --preflight               Validate prerequisites without installing
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

install_managed_bun() {
  local version asset url expected_sha version_dir archive temp_dir actual_sha
  version="$(manifest_value distribution.bun.version)"
  asset="$(manifest_value distribution.bun.asset)"
  url="$(manifest_value distribution.bun.url)"
  expected_sha="$(manifest_value distribution.bun.sha256)"
  version_dir="$BUN_RUNTIME_DIR/bun-$version"

  if [[ -x "$version_dir/bun" ]]; then
    [[ "$($version_dir/bun --version)" == "$version" ]] || {
      printf 'Managed Bun version mismatch in %s\n' "$version_dir" >&2
      exit 1
    }
    BUN_PATH="$version_dir/bun"
    return 0
  fi

  for dependency in curl unzip sha256sum uname; do
    command -v "$dependency" >/dev/null 2>&1 || {
      printf '%s is required to bootstrap managed Bun %s\n' "$dependency" "$version" >&2
      exit 1
    }
  done
  [[ "$(uname -s)" == "Linux" && "$(uname -m)" == "x86_64" ]] || {
    printf 'Automatic Bun bootstrap currently supports Linux x86_64 only\n' >&2
    exit 1
  }

  if [[ "$PREFLIGHT_ONLY" -eq 1 || "$DRY_RUN" -eq 1 ]]; then
    log "Managed Bun $version can be bootstrapped in $version_dir"
    BUN_PATH="$version_dir/bun"
    return 0
  fi

  temp_dir="$(mktemp -d)"
  trap 'rm -rf "$temp_dir"' RETURN
  archive="$temp_dir/$asset"
  log "Downloading managed Bun $version"
  curl --fail --location --silent --show-error "$url" --output "$archive"
  actual_sha="$(sha256sum "$archive" | cut -d' ' -f1)"
  [[ "$actual_sha" == "$expected_sha" ]] || {
    printf 'Bun archive checksum mismatch: expected %s, got %s\n' "$expected_sha" "$actual_sha" >&2
    exit 1
  }
  unzip -q "$archive" -d "$temp_dir/extracted"
  [[ -x "$temp_dir/extracted/bun-linux-x64/bun" ]] || {
    printf 'Downloaded Bun archive has no expected executable\n' >&2
    exit 1
  }
  [[ "$($temp_dir/extracted/bun-linux-x64/bun --version)" == "$version" ]] || {
    printf 'Downloaded Bun version mismatch\n' >&2
    exit 1
  }
  mkdir -p "$BUN_RUNTIME_DIR"
  mv "$temp_dir/extracted/bun-linux-x64" "$version_dir"
  BUN_PATH="$version_dir/bun"
  trap - RETURN
  rm -rf "$temp_dir"
  log "Managed Bun $version installed in $version_dir"
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

validate_local_opencode_version() {
  local opencode_bin="$INSTALL_ROOT/bin/opencode" actual_version
  [[ -x "$opencode_bin" ]] || {
    printf 'A local OpenCode installation is required at %s\n' "$opencode_bin" >&2
    return 1
  }
  actual_version="$("$opencode_bin" --version)"
  if ! python3 - "$REPO_DIR/manifest/compat.json" "$actual_version" <<'PY'
import json
import pathlib
import sys

manifest = json.loads(pathlib.Path(sys.argv[1]).read_text())
actual = sys.argv[2].strip()
supported = manifest["opencode"]["modes"]["managed-local-install"]["supportedVersions"]
raise SystemExit(0 if actual in supported else 1)
PY
  then
    printf 'OpenCode %s is not supported by this Background addon revision\n' "$actual_version" >&2
    return 1
  fi
  log "OpenCode local compatible: $actual_version"
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --target-dir) TARGET_DIR="$2"; shift 2 ;;
    --workspace-dir) WORKSPACE_DIR="$2"; shift 2 ;;
    --opencode-root) OPENCODE_ROOT="$2"; shift 2 ;;
    --install-root) INSTALL_ROOT="$2"; shift 2 ;;
    --bun-path) BUN_PATH="$2"; shift 2 ;;
    --bun-runtime-dir) BUN_RUNTIME_DIR="$2"; shift 2 ;;
    --preflight) PREFLIGHT_ONLY=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

for dependency in python3 node git realpath; do
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

validate_local_opencode_version

opencode_version="$(manifest_value distribution.preferredOpenCodeVersion)"
source_repository="$(manifest_value distribution.sourceRepository)"
if [[ -z "$OPENCODE_ROOT" ]]; then
  OPENCODE_ROOT="$WORKSPACE_DIR/opencode-background-source-$opencode_version"
fi

if [[ -z "$BUN_PATH" ]]; then
  BUN_PATH="$(command -v bun || true)"
fi
if [[ -z "$BUN_PATH" && -x "$HOME/.bun/bin/bun" ]]; then
  BUN_PATH="$HOME/.bun/bin/bun"
fi
if [[ -z "$BUN_PATH" && -x "$HOME/.local/bin/bun" ]]; then
  BUN_PATH="$HOME/.local/bin/bun"
fi
if [[ -z "$BUN_PATH" ]]; then
  install_managed_bun
fi
[[ -n "$BUN_PATH" && ( -x "$BUN_PATH" || "$PREFLIGHT_ONLY" -eq 1 || "$DRY_RUN" -eq 1 ) ]] || {
  printf 'A Bun executable is required and automatic bootstrap failed\n' >&2
  exit 1
}

if [[ "$PREFLIGHT_ONLY" -eq 1 ]]; then
  log "Preflight OK: Bun available or bootstrap-ready at $BUN_PATH"
  exit 0
fi

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
