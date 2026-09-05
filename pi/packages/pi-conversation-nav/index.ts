import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const NAVIGATE_SCRIPT = fileURLToPath(new URL("./navigate.sh", import.meta.url));
type Target = "top" | "bottom" | "toggle";
interface CommandResult {
  code: number;
  stderr: string;
}

async function navigate(target: Target, pane: string): Promise<CommandResult> {
  try {
    const { stderr } = await execFileAsync("/bin/bash", [NAVIGATE_SCRIPT, target, pane], { timeout: 3000 });
    return { code: 0, stderr };
  } catch (error) {
    const failure = error as { code?: number; stderr?: string };
    return { code: typeof failure.code === "number" ? failure.code : 1, stderr: failure.stderr ?? "" };
  }
}

function targetFromPayload(payload: unknown): Target | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const target = (payload as { target?: unknown }).target;
  return target === "top" || target === "bottom" || target === "toggle" ? target : undefined;
}

export default function conversationNav(pi: ExtensionAPI): void {
  let currentContext: ExtensionContext | undefined;

  pi.on("session_start", (_event, ctx) => {
    currentContext = ctx;
  });
  pi.on("session_shutdown", () => {
    currentContext = undefined;
  });

  async function jump(requested: Target, commandContext?: ExtensionCommandContext): Promise<void> {
    const pane = process.env.TMUX_PANE;
    const ctx = commandContext ?? currentContext;
    if (!process.env.TMUX || !pane) {
      ctx?.ui.notify("Conversation navigation requires tmux.", "warning");
      return;
    }

    const result = await navigate(requested, pane);
    if (result.code !== 0) {
      ctx?.ui.notify(result.stderr.trim() || "Could not navigate the latest response.", "warning");
    }
  }

  pi.events.on("pi-vim:conversation-nav", (payload: unknown) => {
    const target = targetFromPayload(payload);
    if (target) void jump(target);
  });

  for (const [name, target, description] of [
    ["response-top", "top", "Jump to the start of the latest assistant response"],
    ["response-bottom", "bottom", "Jump to the end of the latest assistant response"],
    ["response-toggle", "toggle", "Toggle between the start and end of the latest assistant response"],
  ] as const) {
    pi.registerCommand(name, {
      description,
      handler: async (_args, ctx) => jump(target, ctx),
    });
  }
}
