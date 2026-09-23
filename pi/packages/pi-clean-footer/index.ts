import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { installCodexAccounts } from "../pi-codex-accounts/index";

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
  let thinkingLevel = "high";
  let modelName = "model unavailable";
  let accountRows: { text: string; active: boolean }[] | undefined;

  pi.events.on("vipi:codex-accounts", (payload: unknown) => {
    if (typeof payload !== "object" || payload === null) return;
    const rows = (payload as { rows?: unknown }).rows;
    if (!Array.isArray(rows) || rows.length !== 2 || !rows.every(row => row && typeof row.text === "string" && typeof row.active === "boolean")) return;
    if (JSON.stringify(accountRows) === JSON.stringify(rows)) return;
    accountRows = rows;
    requestRender?.();
  });

  pi.events.on("pi-vim:status-line", (payload: unknown) => {
    if (typeof payload !== "object" || payload === null) return;
    const value = payload as { text?: unknown; mode?: unknown };
    if (typeof value.text !== "string" || typeof value.mode !== "string") return;
    if (vimStatus.text === value.text && vimStatus.mode === value.mode) return;
    vimStatus = { text: value.text, mode: value.mode };
    requestRender?.();
  });

  pi.on("model_select", async (event) => {
    modelName = event.model.id.replace(/-/g, " ");
    thinkingLevel = pi.getThinkingLevel();
    requestRender?.();
  });

  pi.on("thinking_level_select", async (event) => {
    thinkingLevel = event.level;
    requestRender?.();
  });

  pi.on("after_provider_response", async (event) => {
    if (accountRows !== undefined) return; // Account-tagged usage is owned by the router.
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
    // Pre-existing restored Pi processes have a frozen --no-extensions/-e list.
    // /reload updates this footer but cannot add the newly installed account package.
    let accountsEnabled = false;
    try {
      const settings = JSON.parse(readFileSync(resolve(getAgentDir(), "settings.json"), "utf8"));
      accountsEnabled = settings.packages?.some((source: unknown) => typeof source === "string" && source.endsWith("/pi-codex-accounts")) === true;
    } catch {}
    // A leftover provider is not proof that its usage publisher survived reload.
    pi.events.emit("vipi:codex-accounts:request", {});
    if (accountsEnabled && accountRows === undefined) {
      try {
        const start = await installCodexAccounts(pi);
        start();
      } catch {
        accountRows = [1, 2].map(number => ({ text: `account${number} status unavailable`, active: false }));
        ctx.ui.notify("Codex 계정 확장을 불러오지 못했습니다. 새 Pi에서 다시 확인하세요.", "warning");
      }
    }
    thinkingLevel = pi.getThinkingLevel();
    modelName = ctx.model?.id.replace(/-/g, " ") ?? "model unavailable";
    ctx.ui.setFooter((tui, theme) => {
      requestRender = () => tui.requestRender();
      return {
        dispose() {
          requestRender = undefined;
        },
        invalidate() {},
        render(width: number): string[] {
          const rows = accountRows ?? [
            { text: weeklyUsage ? `Usage ${formatPercent(100 - weeklyUsage.usedPercent)}% Left` : "Usage checking...", active: true },
            { text: "", active: false },
          ];
          const vimColor = vimStatus.text.startsWith(":")
            ? "warning"
            : vimStatus.mode.startsWith("visual")
              ? "customMessageLabel"
              : "muted";
          const leftRows = [theme.fg(vimColor, vimStatus.text.trim() || "NORMAL"), theme.fg("dim", `${modelName} ${thinkingLevel[0].toUpperCase()}${thinkingLevel.slice(1)}`)];
          return leftRows.map((value, index) => {
            const left = truncateToWidth(value, width, "");
            const leftWidth = visibleWidth(left);
            const row = rows[index];
            const right = truncateToWidth(theme.fg(row.active ? "muted" : "dim", row.text), Math.max(0, width - leftWidth - 2), "…");
            return `${left}${" ".repeat(Math.max(0, width - leftWidth - visibleWidth(right)))}${right}`;
          });
        },
      };
    });
  });
}
