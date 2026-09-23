# Pi Clean Footer

Replaces Pi's built-in footer with two aligned rows:

```text
NORMAL                            first@example.com | Usage 45% Left
gpt 6 sol High                               account2 not connected
```

The left first row is owned by `pi-vim-local` and shows the active Vim mode, pending Normal command, or live EX command. The current model ID (hyphens replaced by spaces) and capitalized thinking level are directly below it, without a `Thinking:` label. Model selection updates the row immediately. The right side shows account 1 then account 2, each right-aligned on its own row. The active account is brighter; narrow terminals truncate the account text before hiding the left-side state. `Shift+Tab` changes the thinking level and updates the footer immediately. Workspace and session names are intentionally omitted.

The footer never changes the selected thinking level; new sessions use the configured default (`high`). With `pi-codex-accounts`, connected rows show `email | Usage 43% Left`; missing slots show `account1 not connected` / `account2 not connected`. Email is read from OAuth claims in memory, never copied into the usage cache. The footer prefers weekly quota (longest reported window if no weekly window exists); `/codex-accounts` still shows all windows and reset times. `~` means an old/error-cached value and `checking...` means its reset time has passed. Without that extension, a single usage row remains available. Codex reports the percentage already used for its 10,080-minute (seven-day) window. The footer displays `100 - usedPercent`, so it always shows the percentage remaining. Until Pi receives such a response it displays `Usage checking...`; it never substitutes context-window usage for weekly account usage.

Last known usage is stored at:

```text
~/.pi/agent/codex-weekly-usage.json
```

The custom footer intentionally omits token totals, cost, context-window percentage, provider details, session title, workspace title, and extension status lines such as the MCP enabled message.
