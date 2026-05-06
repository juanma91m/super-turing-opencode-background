# Upstream readiness

## Host hooks required to eliminate the patch

### Generic host APIs that the addon depends on

1. **Keybind sequences**
   - current state: `generic-ok`
   - role: exact multi-stroke sequences such as `ctrl+b ctrl+b`

2. **Prompt submit intercept**
   - current state: `needs-review`
   - role: lets the addon reroute same-session prompts to `promptAsync`
   - note: the capability is correct; the naming/shape could be revisited upstream

3. **allowSubmitWhenBusy**
   - current state: `needs-review`
   - role: keeps the inline prompt available when the addon wants a busy session to behave as logically available
   - note: a richer busy strategy may be a better long-term host API than a boolean

4. **session_notice**
   - current state: `generic-ok`
   - role: renders inspection notices without hardcoding feature copy in the core

5. **session.registerAdapter(...)**
   - current state: `generic-ok`
   - role: lets the addon provide the projection policy for the native `session` view

6. **session.registerListAdapter(...)**
   - current state: `generic-ok`
   - role: keeps the native session switcher generic while the addon owns logical selection behavior

## What is addon-specific and should stay outside the core

- tracking of same-session background runs
- background task metadata and KV layout
- `/bg-tasks` command and UI
- inspection host/session semantics for this feature
- prompt retargeting policy for this addon

## Minimal upstream sequence

Suggested sequence of generic upstream changes:

1. upstream the keybind sequence support if it is not yet present in the official build
2. upstream prompt interception in a more clearly named host API if needed
3. upstream the session projection adapter
4. upstream the session list adapter
5. once those hooks exist in an official release, activate `plugin-only` mode in this addon

## What still blocks a real addon today

If OpenCode official does **not** ship the hooks above, this addon still needs a host patch.

That means the remaining blocker is no longer feature logic; it is **host hook availability in official OpenCode builds**.
