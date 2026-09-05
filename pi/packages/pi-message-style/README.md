# pi-message-style

- Prefixes every rendered user message with the same two-cell left margin and bold green `>` used by the prompt editor.
- Normalizes assistant H3-H6 headings to H2 outside fenced code. Pi renders H2 without exposing the source `###` prefix.
- The Vim theme paints Pi's synthetic fenced-code border in the black background color, hiding the literal triple-backtick lines while preserving syntax-highlighted code content.

All transformations are display-only; stored messages and model context are unchanged. User prose uses the theme's normal white text rather than yellow.
