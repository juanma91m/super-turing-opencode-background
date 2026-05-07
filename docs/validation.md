# Validation guide

## Smoke validation

Run against a supported source checkout:

```bash
node ./scripts/smoke.mjs --opencode-root /path/to/opencode-checkout
```

This executes:

- `status`
- `enable --dry-run`
- `disable --dry-run`
- `reapply --dry-run`

Expected today on a supported checkout:

- mode: `patched-source-checkout`
- patch state: `applied` or `not_applied`/`would_*` depending on the command

## Expected safety guarantees

- unsupported targets fail explicitly,
- dry-runs do not mutate plugin state or apply/revert patches,
- real lifecycle commands should be used only on a compatible and reviewable checkout.

## Unsupported-target validation

To verify honest failure on non-supported installs:

```bash
node ./scripts/status.mjs --json
```

Expected result in the current environment when only a binary install is visible:

- target mode resolves to `unsupported`
- no patch operation is attempted
- the command explains that a compatible source checkout is required

## Managed local install dry-run validation

To validate takeover planning without touching the current install:

```bash
node ./scripts/enable.mjs --opencode-root /path/to/opencode-checkout
node ./scripts/adopt-local-install.mjs \
  --checkout-root /path/to/opencode-checkout \
  --bun-path /path/to/bun \
  --dry-run
```

Expected result:

- mode resolves to `managed-local-install`
- a backup path is planned
- the original install root is identified explicitly
- no mutation is performed in dry-run mode
- the command fails early if the addon plugin is not already installed via `enable`

## Managed local install post-adoption validation

After a real `adopt-local-install`, validate the adopted install itself:

```bash
node ./scripts/status.mjs --install-root ~/.opencode --json
~/.opencode/bin/opencode --version
```

Expected result:

- `managedLocalInstall.health` is `adopted`
- `managedLocalInstall.runtimeBinaryPath` points inside `~/.opencode/bin/`
- `managedLocalInstall.launcher.matchesExpected` is `true`
- `managedLocalInstall.problems` is empty
- the launcher keeps working without needing the original checkout path at runtime

To verify that the launcher is not tied to a temporary checkout, inspect it directly:

```bash
grep -n "opencode-managed-runtime\|/tmp/" ~/.opencode/bin/opencode
```

Expected result:

- the launcher references `opencode-managed-runtime`
- it does **not** need to reference `/tmp`

## Restore safety validation

To validate restore planning without mutating the install:

```bash
node ./scripts/restore-local-install.mjs --install-root ~/.opencode --dry-run
```

Expected result:

- the command succeeds when the adopted install is healthy, or when the only remaining drift is a recoverable legacy runtime issue
- if marker, launcher or backup drift, the command fails explicitly instead of overwriting the install root
- legacy runtime drift (`runtime_missing` or an unmanaged legacy runtime path) remains recoverable as long as marker + backup are still valid
