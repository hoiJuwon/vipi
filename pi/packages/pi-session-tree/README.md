# pi-session-tree (local)

A Vim EX-command-driven tmux sidebar for persistent and live Pi sessions.

This local package is derived from the MIT-licensed `pi-jump` 2.1.3 by Sagar Sarkale. It uses a local registry plus a real tmux split and a plugin-free Neovim UI.

## Open and close

From pi-vim NORMAL mode:

```vim
:e .
:e ..
:e ~/project
:sessions .
```

`:e .` creates a real fixed 45-column tmux pane on the left. The tree restores that width after terminal/client resizing and when reusing an existing tree pane, so every session keeps the same sidebar size. Running it again from Pi closes every persistent tree pane in the current tmux session, so the sidebar toggles as one UI instead of leaving stale per-window copies. `q` or `Esc` inside a tree closes that window's copy. Pi remains in regular TUI mode, reflows to the available width, and retains tmux copy-mode history. On the first visit to another tmux window, the tree prepares a separate sidebar in that off-screen window; later switches reuse both layouts instead of moving the pane with `join-pane`, avoiding the intermediate full-screen reflow/flash.

Every existing Pi session file remains visible until it is explicitly deleted, including sessions whose Pi process exited with `:q` or whose tmux pane disappeared. Sessions remain grouped first by their exact launch directory. Within each workspace they are grouped by topic in `개발 → 마케팅 → 분석 → other/custom topics → 기타` order, with `기타` always last; unlisted topics are ordered by topic name, and sessions within the same topic retain creation order. Status and selection never reorder them, while an explicit category rename intentionally moves the row into its new topic group. Workspace headings and the root label show at most the final three path components (the workspace plus its parent and grandparent). Registered workspaces remain visible with `세션 없음` even when no Pi is running. Workspace headings and session rows are selectable; `n` defaults to the selected workspace. Each session gets a sequential number on the left, while dormant/idle/working/unread state is aligned three cells in from the right pane edge. The selected row gets a full-width ANSI-236 (`#303030`) gray background.

## Tree keys

- `j` / `k`: next/previous numbered session; workspace headings and empty-state rows are skipped
- `g` / `G`: first/last numbered session
- `gt`: next session
- `{count}gt`: open the numbered session (`1gt` opens session 1)
- `gT` / `{count}gT`: previous session / move back by count
- `Enter` or `l`: focus a live Pi, or immediately reopen a dormant session in a new tmux window
- left mouse click on a numbered session row: move the tree cursor and run the same open/reopen path as `Enter`; workspace headings and empty rows remain non-opening
- `/`: native Neovim search
- `n`: choose/create a folder, register it as a workspace, immediately insert a provisional `이름 생성 중` row, and start Pi there; startup atomically replaces that row with the real session ID/file
- `a`: register an existing folder as an empty workspace without starting Pi
- `r`: edit the complete authoritative `분류 / 내용` name; changing the left side also updates the stored topic and synchronizes the full name back into the target Pi process
- `x`: explicitly delete the selected session file after confirmation (the only action that removes a session from the tree)
- `q` / `Esc`: close the tree

Pi-Vim publishes each pane's editor state through `@pi_vim_state`, while the rendered footer is treated as the authoritative state so older/reloaded panes cannot leave a stale option behind. Both `gt/gT` and tree `Enter/l` send `Escape` only when an existing destination is INSERT, VISUAL, EX, or pending, so activated existing sessions open in NORMAL without interrupting a destination already in NORMAL. A brand-new session created with tree `n` explicitly skips this normalization and preserves Pi-Vim's initial INSERT mode. Reopened dormant sessions still wait briefly for their initial footer before NORMAL normalization.

Closing Pi with `:q`, closing a tmux pane, or restarting the machine only makes a session dormant; it does not remove the session from the tree. Deleting the current owner session is allowed after confirmation; Pi closes while the tree stays open so another session can be selected.

## Automatic naming

Naming runs only for the first prompt of an unnamed session. A provisional `이름 생성 중` row carries no topic or name, so it cannot accidentally lock `기타`. The extension locks the left-side topic immediately. Strong data-analysis intent (`첫결제`, `재구매`, churn, segment, cohort, funnel, retention, conversion, behavioral/event/raw data aggregation or visualization) is classified as `데이터` even when a supporting analysis dashboard is requested. Otherwise `개발` takes precedence whenever the request mentions code implementation/modification, debugging, testing, deployment, branch, API/backend/frontend/database work, component/page/dashboard/app/web work, development tooling, a code file extension, or an equivalent development action. Database/schema/API implementation and dashboard frontend implementation therefore remain `개발`. It asks `openai-codex/gpt-5.4-mini` only for the right-side content, and then sets the actual session name once. It never auto-renames the session again on later prompts. A later `/name` or tree `r` rename becomes authoritative in the registry and is restored into the Pi process before subsequent agent events, preventing old names from returning. Tree `r` presents the full `분류 / 내용` string, and `/name 분류 / 내용` likewise replaces the stored topic; a summary-only `/name` preserves the existing topic.

The topic classifier uses these fixed examples:

```text
개발 / CI 정리
마케팅 / 콘텐츠 업로드
기타 / 파일 정리
분석 / 사용자 지표 검토
문서 / API 가이드 작성
```

The initially inferred topic remains fixed during automatic naming and status refreshes, but an explicit full rename may replace it. Tree `r` requires `분류 / 내용`; `/name 분류 / 내용` also replaces the topic, while a summary-only `/name` keeps it. The naming request has a 15-second timeout and uses a deterministic content fallback on error.

## Status

- bold red `●`: the MCP adapter has entered a real tool-approval or elicitation lifecycle and is awaiting user interaction; it publishes a pane-local `@pi_permission_waiting=mcp:<publisher-pid>` marker before opening the UI and clears it in `finally` after accept/decline/cancel/error. Input, agent, tool, session-start, and session-shutdown boundaries also force-clear orphaned markers, and the tree accepts a marker only while its publisher process is alive. The tree never scans rendered text, so messages containing button labels cannot trigger this state. All pane options are read in one cached `list-panes` snapshot rather than one tmux process per live session, preventing session-count-dependent input stalls. This takes priority over the spinner.
- bold yellow original Braille spinner (`⠋ ⠙ ⠹ …`): Pi is generating/running tools
- bold green `●`: completed while not being viewed; unread (explicit Pi state or sidebar-observed `working → idle` transition)
- bold dim `○`: live and idle/read
- dim `·`: dormant; pressing Enter reopens it
- all status glyphs share one fixed right-aligned column with a three-cell right margin; current selection is indicated only by its gray row background

Selecting a session marks it read. An unread session also clears automatically when its Pi pane becomes the active tmux client pane.

## Storage and access

State files:

```text
~/.pi/agent/tmux-session-tree.json
~/.pi/agent/tmux-session-catalog.json
~/.pi/agent/tmux-workspaces.json
```

The sidebar itself makes no network requests and runs `nvim --clean` with only `tree.lua`. Automatic naming uses the configured Pi model registry once per unnamed session.
