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
