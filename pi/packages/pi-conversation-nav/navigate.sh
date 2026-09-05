#!/bin/bash
set -euo pipefail

target=${1:-}
pane=${2:-${TMUX_PANE:-}}

if [[ -z "$pane" ]]; then
  echo "pi-conversation-nav: no tmux pane" >&2
  exit 1
fi

case "$target" in
  top|bottom) ;;
  toggle)
    last=$(tmux show-options -p -v -t "$pane" @pi_conversation_nav_last 2>/dev/null || true)
    if [[ "$last" == "top" ]]; then target=bottom; else target=top; fi
    ;;
  *)
    echo "pi-conversation-nav: expected top, bottom, or toggle" >&2
    exit 2
    ;;
esac

tmux copy-mode -t "$pane"
tmux send-keys -t "$pane" -X history-bottom
if [[ "$target" == "top" ]]; then
  tmux send-keys -t "$pane" -X previous-prompt
  tmux send-keys -t "$pane" -X scroll-top
else
  tmux send-keys -t "$pane" -X previous-prompt -o
  tmux send-keys -t "$pane" -X scroll-bottom
fi
tmux set-option -p -t "$pane" @pi_conversation_nav_last "$target"
