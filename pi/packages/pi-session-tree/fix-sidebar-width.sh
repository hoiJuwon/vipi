#!/bin/sh

width=45

tmux list-panes -a -F '#{pane_id}	#{@pi_session_tree}	#{pane_width}' 2>/dev/null |
while IFS="$(printf '\t')" read -r pane marker current_width; do
  if [ "$marker" = "1" ] && [ "$current_width" != "$width" ]; then
    tmux resize-pane -t "$pane" -x "$width" 2>/dev/null || true
  fi
done
