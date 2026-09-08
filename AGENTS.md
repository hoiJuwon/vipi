# Agent entry point

Read README.md before changing or installing this repository. The repo is PUBLIC; vipi-ios is a PRIVATE submodule.

## Source of truth
- `pi/packages/`: local Pi extensions; installed with per-package symlinks.
- `pi/settings.json`, `pi/AGENTS.md`, `config/tmux.conf`: portable templates, rendered by `scripts/setup.py`.
- `pi/themes/`, `pi/response-styles/`: linked resources.
- `patches/`: reviewed patch against exactly pi-mcp-adapter 2.27.0.
- `scripts/vipi`: workspace checkpoint/restore CLI; read `docs/workspace.md` before changing lifecycle behavior.
- `vipi-ios/`: pinned submodule; do not edit its contents for host config changes.
- `machine.local.json`: ignored per-machine values. Never stage it.

## Required workflow
1. Inspect current state and user intent; do not stop running Pi/ML jobs to install config.
2. Modify tracked sources, not node_modules or generated settings alone.
3. Run `python3 scripts/check.py`, `python3 scripts/setup.py` (dry run), then explicit `--apply` only when authorized.
4. After npm adapter reinstall, run `sh scripts/patch-mcp.sh`; reject version mismatches.
5. Before push, inspect staged diff for secrets and machine paths. Never add `~/.pi/agent` wholesale.
6. Workspace changes must pass `scripts/test-workspace.py` and `scripts/test-workspace-tui.py`. Never test server destruction on the user's default tmux socket.
7. State which checks actually ran. Tests here are offline configuration/structure checks, not full TUI or provider authentication tests.

Keep regular TUI, explicit REVIEW, fixed 45-column tree, Astra/medium default, Korean Direct, and disabled IME switching unless requested otherwise. Do not delete permanent integration branches. Do not rewrite the private submodule remote to a local filesystem URL. Runtime registries, sessions, auth, APNs keys, MCP cache, attachments, model caches, and iOS pairing tokens stay outside this repository.
