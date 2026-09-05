# pi-activity-line

A compact live activity line for Pi's regular TUI. It keeps Pi's native working indicator and replaces vague working text with the current phase, a concise tool description, and elapsed time.

Examples:

```text
⠹ Thinking · 1.8s
⠹ Reading pi-vim-local/index.ts · 2.3s
⠹ Editing session-tree/tree.lua · 1.1s
⠹ Running tests · 8.4s
⠹ Writing response · 3.2s
⠹ Reading src/a.ts · +2 parallel · 1.4s
```

Recognized built-in tools:

- `read`, `edit`, `write`, `ls`
- `grep`, `find`
- `bash`, with concise labels for tests, type checks, lint, builds, installs, Git inspection, and searches

Other tools render as `Using <tool name>`. Paths are limited to their final two components and long details are truncated.

## Command

```text
/activity-line
/activity-line on
/activity-line off
```

The activity line is enabled by default for every new Pi process. The toggle is session-local. Timers only run while an agent is active and are cleaned up on settle, shutdown, and reload.
