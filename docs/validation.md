# Validation guide

## Responsibility-scoped catalog

Run `node --test test/*.test.mjs` for the existing lifecycle tests and the catalog
regressions. These execute the actual TypeScript policy/handlers with host I/O
fixtures; they do not launch a model, delegation or worktree. The test-only loader
must not be copied into the runtime plugin or exported as another plugin factory.
That test loader uses Node's experimental `stripTypeScriptTypes` API (validated
with Node 22.23.2); this is a test prerequisite, not a new plugin runtime dependency.

For opt-in native plugin-loading and host-contract checks, set:

```bash
OPENCODE_BACKGROUND_NATIVE=1 \
OPENCODE_BACKGROUND_DEPS=/absolute/path/to/existing/node_modules \
OPENCODE_RUNTIME_SOURCE=/absolute/path/to/the/matching/opencode-source \
node --test test/catalog-visibility.test.mjs
```

The native fixture uses a separate HOME/XDG/config/data directory and existing
dependencies, disables provider-plugin discovery and model metadata fetches, and
loads the complete candidate Background plugin. `opencode debug config` and
`debug agent` inspect its resolved config/catalog without executing tools. Missing
opt-ins are reported as skipped tests, not evidence of native validation.

Before promotion, compare global and every applicable project profile, both
canonical and installed assets. Expect only four concrete deny rules for active
non-master roles. `master-dev`, disabled agents, native identity/defaults and all
other permissions/metadata must remain unchanged. Test wildcard order, repeated
composition, unknown configured agents, existing master denies/ask/tool flags,
session restrictions and child message masks. Preserve the read-only delegation
matrix and the nine other Background tools; hidden agents are not disabled agents.

Direct handler/validator fixtures must still reject unauthorized callers even
when a schema is forcibly exposed, before worktree/Git/session/state mutations.
Positive cases reach only fixture managers; invalid targets, nested launch,
unreviewed/unaccepted states, dirty workspace and invalid patch remain rejected.
Do not claim real-worktree, LLM-obedience, end-to-end delegation, token, latency or
quality results from these checks. A stock managed plugin hash may be replaced
only with its required backup; unknown modified hashes must still be refused.

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
- `managedLocalInstall.auxiliaryBinEntries` has no entries with `ok: false`
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

## Managed local upgrade validation

To validate migration from one supported managed install to another:

```bash
node ./scripts/restore-local-install.mjs
node ./scripts/enable.mjs --opencode-root /path/to/new-opencode-checkout
node ./scripts/adopt-local-install.mjs \
  --checkout-root /path/to/new-opencode-checkout \
  --bun-path /path/to/bun
node ./scripts/status.mjs --install-root ~/.opencode --json
```

Expected result:

- `managedLocalInstall.health` is `adopted`
- `managedLocalInstall.checkoutVersion` matches the new supported version
- `managedLocalInstall.launcher.matchesExpected` is `true`
- `managedLocalInstall.problems` is empty
