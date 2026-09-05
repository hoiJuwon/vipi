import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

const USAGE_PATH = resolve(homedir(), ".pi", "agent", "codex-weekly-usage.json");
const WEEK_MINUTES = 7 * 24 * 60;

type WeeklyUsage = {
  usedPercent: number;
  resetsAt?: number;
  updatedAt: string;
};

function readUsage(): WeeklyUsage | undefined {
  try {
    const value = JSON.parse(readFileSync(USAGE_PATH, "utf8")) as Partial<WeeklyUsage>;
    if (typeof value.usedPercent !== "number" || !Number.isFinite(value.usedPercent)) return undefined;
    return {
      usedPercent: Math.max(0, Math.min(100, value.usedPercent)),
      resetsAt: typeof value.resetsAt === "number" ? value.resetsAt : undefined,
      updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString(),
    };
  } catch {
    return undefined;
  }
}

function saveUsage(value: WeeklyUsage): void {
  mkdirSync(dirname(USAGE_PATH), { recursive: true });
  const temporary = `${USAGE_PATH}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, USAGE_PATH);
}

function numberHeader(headers: Record<string, string>, key: string): number | undefined {
  const value = Number.parseFloat(headers[key] ?? "");
  return Number.isFinite(value) ? value : undefined;
}

export function weeklyUsageFromHeaders(rawHeaders: Record<string, string>): WeeklyUsage | undefined {
  const headers = Object.fromEntries(Object.entries(rawHeaders).map(([key, value]) => [key.toLowerCase(), value]));
  for (const slot of ["primary", "secondary"] as const) {
    const prefix = `x-codex-${slot}`;
    const usedPercent = numberHeader(headers, `${prefix}-used-percent`);
    const windowMinutes = numberHeader(headers, `${prefix}-window-minutes`);
    if (usedPercent === undefined || windowMinutes === undefined) continue;
    if (Math.abs(windowMinutes - WEEK_MINUTES) > 60) continue;
    return {
      usedPercent: Math.max(0, Math.min(100, usedPercent)),
      resetsAt: numberHeader(headers, `${prefix}-reset-at`),
      updatedAt: new Date().toISOString(),
    };
  }
  return undefined;
}

function formatPercent(value: number): string {
  return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1);
}

export default function cleanFooter(pi: ExtensionAPI) {
  let weeklyUsage = readUsage();
  let requestRender: (() => void) | undefined;
  let vimStatus: { text: string; mode: string } = { text: "", mode: "normal" };
  let thinkingLevel = "medium";

  pi.events.on("pi-vim:status-line", (payload: unknown) => {
    if (typeof payload !== "object" || payload === null) return;
    const value = payload as { text?: unknown; mode?: unknown };
    if (typeof value.text !== "string" || typeof value.mode !== "string") return;
    vimStatus = { text: value.text, mode: value.mode };
    requestRender?.();
  });

  pi.on("thinking_level_select", async (event) => {
    thinkingLevel = event.level;
    requestRender?.();
  });

  pi.on("after_provider_response", async (event) => {
    const next = weeklyUsageFromHeaders(event.headers);
    if (!next) return;
    weeklyUsage = next;
    try {
      saveUsage(next);
    } catch {}
    requestRender?.();
  });

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    pi.setThinkingLevel("medium");
    thinkingLevel = pi.getThinkingLevel();
    ctx.ui.setFooter((tui, theme) => {
      requestRender = () => tui.requestRender();
      return {
        dispose() {
          requestRender = undefined;
        },
        invalidate() {},
        render(width: number): string[] {
          const usageText = weeklyUsage
            ? `Weekly Usage Limit: ${formatPercent(100 - weeklyUsage.usedPercent)}% remaining`
            : "Weekly Usage Limit: checking...";
          const right = theme.fg("dim", `Thinking: ${thinkingLevel}  ${usageText}`);
          const vimColor = vimStatus.text.startsWith(":")
            ? "warning"
            : vimStatus.mode.startsWith("visual")
              ? "customMessageLabel"
              : "muted";
          const vim = vimStatus.text ? theme.fg(vimColor, vimStatus.text) : "";
          const rightWidth = visibleWidth(right);
          const vimWidth = visibleWidth(vim);
          if (vimWidth + rightWidth + 1 <= width) {
            return [`${vim}${" ".repeat(width - vimWidth - rightWidth)}${right}`];
          }
          const availableForVim = Math.max(0, width - rightWidth - 1);
          if (availableForVim > 0) {
            const left = truncateToWidth(vim, availableForVim, "");
            const leftWidth = visibleWidth(left);
            return [`${left}${" ".repeat(Math.max(1, width - leftWidth - rightWidth))}${right}`];
          }
          return [truncateToWidth(right, width, "")];
        },
      };
    });
  });
}
