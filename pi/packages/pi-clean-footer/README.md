# Pi Clean Footer

Replaces Pi's built-in footer with one aligned row:

```text
NORMAL                   Thinking: high  Weekly Usage Limit: 1* 주45% · 2 주80%
```

The left side is owned by `pi-vim-local` and shows the active Vim mode, pending Normal command, or live EX command. The right side shows the current effective thinking level immediately before weekly Codex usage. `Shift+Tab` changes the thinking level and updates the footer immediately. Workspace and session names are intentionally omitted.

The footer never changes the selected thinking level; new sessions use the configured default (`high`). With `pi-codex-accounts`, it shows both accounts' remaining quota, `*` for the current session's account, and `미연결` for a missing login. Available short-window limits appear alongside weekly limits; `~` means an old/error-cached value and `?` means its reset time has passed. Without that extension, the legacy single-account display remains available. Codex reports the percentage already used for its 10,080-minute (seven-day) window. The footer displays `100 - usedPercent`, so it always shows the percentage remaining. Until Pi receives such a response it displays `Weekly Usage Limit: checking...`; it never substitutes context-window usage for weekly account usage.

Last known usage is stored at:

```text
~/.pi/agent/codex-weekly-usage.json
```

The custom footer intentionally omits token totals, cost, context-window percentage, model details, session title, workspace title, and extension status lines such as the MCP enabled message.
