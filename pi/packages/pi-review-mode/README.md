# pi-review-mode

Adds an explicit, snapshot-based transcript REVIEW mode without coupling Pi-Vim NORMAL to tmux copy mode.

- `Esc`: enter Pi-Vim NORMAL; live assistant output remains visible.
- `R` in NORMAL: enter tmux REVIEW at the final line of the latest rendered message, column zero.
- `j/k`, `Ctrl+U/D`, `{}`, `/`, `v`, `y`: native tmux review/navigation.
- `Esc`, `Ctrl+C`, or `q`: leave REVIEW and return to Pi-Vim NORMAL.
- `i`, `a`, `A`, `I`, `o`, or `O`: leave REVIEW and execute that Pi-Vim Insert command.
- `:`: leave REVIEW and enter Pi-Vim EX input.

Run `gt`, `{count}gt`, and `gT` directly in Pi-Vim NORMAL. Conversation `zt`, `zb`, and `zz` keep their existing on-demand copy-mode behavior.

REVIEW intentionally uses tmux's stable snapshot. There is no polling, delayed mode transition, cross-pane forcing, or tmux-side numeric-prefix state.
