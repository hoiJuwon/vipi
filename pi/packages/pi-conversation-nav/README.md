# pi-conversation-nav

Navigates the latest assistant response in Pi's regular TUI using Pi's existing OSC 133 message boundaries and tmux copy mode. It adds no visible transcript markers and does not switch Pi to fullscreen mode.

## Normal-mode keys

Provided through `pi-vim-local`:

- `zt`: latest assistant response start, aligned to the viewport top
- `zb`: latest assistant response end, aligned to the viewport bottom
- `zz`: toggle between those two positions
- the same `zt` / `zb` / `zz` keys remain active after entering tmux copy mode, so they can be chained without leaving review mode
- `q` / `Esc`: leave tmux copy mode using the existing copy-mode bindings

Rapidly typed chunks such as `zt` and `zz` are split by `pi-vim-local`, so behavior does not depend on typing speed.

## Commands

- `/response-top`
- `/response-bottom`
- `/response-toggle`

The extension requires tmux and is intended for Pi's `regular` TUI mode. It relies on the OSC 133 boundaries already emitted by Pi's built-in assistant message renderer. `~/.tmux.conf` installs a temporary `pi-conversation-nav` key table behind `z` in `copy-mode-vi`; this intentionally replaces copy-mode Vim's default `z` (`scroll-middle`) with the conversation prefix.
