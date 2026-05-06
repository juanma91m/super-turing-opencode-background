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

## Expected safety guarantees

- unsupported targets fail explicitly,
- dry-runs do not mutate plugin state or apply/revert patches,
- real lifecycle commands should be used only on a compatible and reviewable checkout.
