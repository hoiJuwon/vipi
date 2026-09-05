import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { basename, dirname } from "node:path";

interface ActiveTool {
  id: string;
  label: string;
  startedAt: number;
  sequence: number;
}

type Phase = "idle" | "thinking" | "writing" | "tool";

const UPDATE_INTERVAL_MS = 500;
const MAX_DETAIL_LENGTH = 52;

function compactPath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/u, "");
  const file = basename(normalized);
  const parent = basename(dirname(normalized));
  return parent && parent !== "." && parent !== "/" ? `${parent}/${file}` : file;
}

function compactText(value: unknown, maximum = MAX_DETAIL_LENGTH): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/gu, " ").trim();
  if (!text) return undefined;
  return text.length > maximum ? `${text.slice(0, maximum - 1).trimEnd()}…` : text;
}

function bashLabel(commandValue: unknown): string {
  const command = compactText(commandValue, 64);
  if (!command) return "Running command";
  const lower = command.toLowerCase();
  if (/\b(tsc|typecheck|type-check)\b/u.test(lower)) return "Checking TypeScript";
  if (/\b(vitest|jest|pytest|cargo test|go test|npm test|pnpm test|yarn test)\b/u.test(lower)) return "Running tests";
  if (/\b(eslint|biome|ruff|shellcheck|lint)\b/u.test(lower)) return "Checking code quality";
  if (/\b(npm|pnpm|yarn|bun)\s+(install|add|update)\b/u.test(lower)) return "Installing dependencies";
  if (/\b(git status|git diff|git log)\b/u.test(lower)) return "Inspecting Git changes";
  if (/^(rg|grep)\b/u.test(lower)) return "Searching code";
  if (/\b(xcodebuild|cargo build|go build|npm run build|pnpm build|yarn build)\b/u.test(lower)) return "Building project";
  return `Running ${command}`;
}

function toolLabel(toolName: string, args: unknown): string {
  const input = typeof args === "object" && args !== null ? args as Record<string, unknown> : {};
  switch (toolName) {
    case "read":
      return `Reading ${compactPath(input.path) ?? "file"}`;
    case "edit":
      return `Editing ${compactPath(input.path) ?? "file"}`;
    case "write":
      return `Writing ${compactPath(input.path) ?? "file"}`;
    case "bash":
      return bashLabel(input.command);
    case "grep": {
      const pattern = compactText(input.pattern, 32);
      const path = compactPath(input.path);
      return `Searching${pattern ? ` for ${pattern}` : " code"}${path ? ` in ${path}` : ""}`;
    }
    case "find": {
      const pattern = compactText(input.pattern, 32);
      const path = compactPath(input.path);
      return `Finding ${pattern ?? "files"}${path ? ` in ${path}` : ""}`;
    }
    case "ls":
      return `Listing ${compactPath(input.path) ?? "directory"}`;
    default:
      return `Using ${toolName.replaceAll("_", " ")}`;
  }
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, milliseconds) / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.floor(seconds % 60)}s`;
}

export default function activityLine(pi: ExtensionAPI): void {
  const activeTools = new Map<string, ActiveTool>();
  let phase: Phase = "idle";
  let phaseStartedAt = Date.now();
  let sequence = 0;
  let enabled = true;
  let timer: NodeJS.Timeout | undefined;
  let currentContext: ExtensionContext | undefined;

  function latestTool(): ActiveTool | undefined {
    return [...activeTools.values()].sort((a, b) => b.sequence - a.sequence)[0];
  }

  function display(ctx = currentContext): void {
    if (!ctx || !enabled || phase === "idle") return;
    let label: string;
    let startedAt = phaseStartedAt;
    if (activeTools.size > 0) {
      const latest = latestTool();
      if (!latest) return;
      label = latest.label;
      startedAt = latest.startedAt;
      if (activeTools.size > 1) label += ` · +${activeTools.size - 1} parallel`;
    } else if (phase === "writing") {
      label = "Writing response";
    } else {
      label = "Thinking";
    }
    ctx.ui.setWorkingMessage(`${label} · ${formatElapsed(Date.now() - startedAt)}`);
  }

  function startTimer(): void {
    if (timer) return;
    timer = setInterval(() => display(), UPDATE_INTERVAL_MS);
    timer.unref?.();
  }

  function stopTimer(): void {
    if (!timer) return;
    clearInterval(timer);
    timer = undefined;
  }

  function setPhase(next: Phase, ctx: ExtensionContext): void {
    if (phase !== next) phaseStartedAt = Date.now();
    phase = next;
    currentContext = ctx;
    if (next === "idle") {
      stopTimer();
      ctx.ui.setWorkingMessage();
      return;
    }
    if (enabled) {
      ctx.ui.setWorkingVisible(true);
      startTimer();
      display(ctx);
    }
  }

  pi.on("session_start", (_event, ctx) => {
    activeTools.clear();
    phase = "idle";
    stopTimer();
    if (ctx.mode !== "tui") return;
    currentContext = ctx;
    ctx.ui.setWorkingMessage();
  });

  pi.on("agent_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    activeTools.clear();
    setPhase("thinking", ctx);
  });

  pi.on("message_update", (event, ctx) => {
    if (ctx.mode !== "tui") return;
    if (event.message.role === "assistant" && activeTools.size === 0 && phase !== "writing") {
      setPhase("writing", ctx);
    }
  });

  pi.on("tool_execution_start", (event, ctx) => {
    if (ctx.mode !== "tui") return;
    const now = Date.now();
    activeTools.set(event.toolCallId, {
      id: event.toolCallId,
      label: toolLabel(event.toolName, event.args),
      startedAt: now,
      sequence: ++sequence,
    });
    phase = "tool";
    currentContext = ctx;
    if (enabled) startTimer();
    display(ctx);
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (ctx.mode !== "tui") return;
    activeTools.delete(event.toolCallId);
    setPhase(activeTools.size > 0 ? "tool" : "thinking", ctx);
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    activeTools.clear();
    setPhase("idle", ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    activeTools.clear();
    phase = "idle";
    stopTimer();
    if (ctx.mode === "tui") ctx.ui.setWorkingMessage();
    currentContext = undefined;
  });

  pi.registerCommand("activity-line", {
    description: "Show or toggle the refined one-line activity indicator",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (!action) {
        ctx.ui.notify(`Activity line: ${enabled ? "on" : "off"}`, "info");
        return;
      }
      if (action !== "on" && action !== "off") {
        ctx.ui.notify("Usage: /activity-line [on|off]", "error");
        return;
      }
      enabled = action === "on";
      if (enabled) {
        if (phase !== "idle") {
          startTimer();
          display(ctx);
        }
      } else {
        stopTimer();
        ctx.ui.setWorkingMessage();
      }
      ctx.ui.notify(`Activity line ${enabled ? "enabled" : "disabled"}.`, "info");
    },
  });
}
