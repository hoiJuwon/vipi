import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function tmux(args: string[]): Promise<void> {
  try {
    await execFileAsync("tmux", args, { timeout: 2000 });
  } catch {
    // REVIEW is optional and must never break Pi-Vim input.
  }
}

export default function reviewMode(pi: ExtensionAPI): void {
  let currentContext: ExtensionContext | undefined;

  pi.on("session_start", (_event, ctx) => {
    currentContext = ctx.mode === "tui" ? ctx : undefined;
  });
  pi.on("session_shutdown", () => {
    currentContext = undefined;
  });

  pi.events.on("pi-vim:review", () => {
    const pane = process.env.TMUX_PANE;
    if (!currentContext || !pane) return;
    void (async () => {
      await tmux(["copy-mode", "-t", pane]);
      await tmux(["send-keys", "-t", pane, "-X", "history-bottom"]);
      await tmux(["send-keys", "-t", pane, "-X", "previous-prompt", "-o"]);
      await tmux(["send-keys", "-t", pane, "-X", "start-of-line"]);
    })();
  });
}
