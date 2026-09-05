import { basename } from "node:path";
import { homedir } from "node:os";
import type { DiscoveredEntry } from "./discover";

const MAX_NAME = 32;
const MAX_CWD = 40;

export function relativeTime(iso: string, now: Date = new Date()): string {
  const s = Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

export function shortenCwd(cwd: string, home: string): string {
  const pretty =
    home && (cwd === home || cwd.startsWith(home + "/"))
      ? "~" + cwd.slice(home.length)
      : cwd;
  if (pretty.length <= MAX_CWD) return pretty;
  return "…" + pretty.slice(pretty.length - (MAX_CWD - 1));
}

export interface RowParts {
  dot: string;
  name: string;
  target: string;
  cwd: string;
  age: string;
  current: boolean;
  source: "registry" | "scan";
}

export function rowParts(
  e: DiscoveredEntry,
  now: Date = new Date(),
  currentPaneId?: string,
  home: string = homedir()
): RowParts {
  const current = currentPaneId !== undefined && e.tmuxPaneId === currentPaneId;
  return {
    // ● = you are here. ○ = everything else. (Not a registry/scan marker.)
    dot: current ? "●" : "○",
    name: truncate(e.name ?? basename(e.cwd), MAX_NAME),
    target: `${e.tmuxSession}:${e.tmuxWindow}`,
    cwd: shortenCwd(e.cwd, home),
    age: relativeTime(e.lastSeen, now),
    current,
    source: e.source,
  };
}

export interface ColumnWidths {
  nameW: number;
  targetW: number;
  cwdW: number;
  ageW: number;
}

export function computeColumnWidths(parts: RowParts[]): ColumnWidths {
  return {
    nameW: Math.max(...parts.map((r) => r.name.length)),
    targetW: Math.max(...parts.map((r) => r.target.length)),
    cwdW: Math.max(...parts.map((r) => r.cwd.length)),
    ageW: Math.max(...parts.map((r) => r.age.length)),
  };
}

export function formatRow(parts: RowParts, widths: ColumnWidths): string {
  return (
    `${parts.dot} ${parts.name.padEnd(widths.nameW)} │ ${parts.target.padStart(widths.targetW)} │ ${parts.cwd.padEnd(widths.cwdW)} │ ${parts.age.padStart(widths.ageW)}`
  );
}

export function formatOptions(
  entries: DiscoveredEntry[],
  now: Date = new Date(),
  currentPaneId?: string
): string[] {
  if (entries.length === 0) return [];
  const home = homedir();
  const parts = entries.map((e) => rowParts(e, now, currentPaneId, home));
  const widths = computeColumnWidths(parts);
  return parts.map((p) => formatRow(p, widths));
}
