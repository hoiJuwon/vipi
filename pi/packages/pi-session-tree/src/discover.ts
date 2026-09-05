import type { JumpEntry } from "./registry";
import type { PaneInfo } from "./tmux";

export interface DiscoveredEntry extends JumpEntry {
  source: "registry" | "scan";
}

export function mergeEntries(registry: JumpEntry[], scanned: JumpEntry[]): DiscoveredEntry[] {
  const registeredPanes = new Set(registry.map((e) => e.tmuxPaneId));
  return [
    ...registry.map((e) => ({ ...e, source: "registry" as const })),
    ...scanned
      .filter((e) => !registeredPanes.has(e.tmuxPaneId))
      .map((e) => ({ ...e, source: "scan" as const })),
  ];
}

export function sortByLastSeen<T extends { lastSeen: string }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

export function scanPaneToEntry(pane: PaneInfo, piPid: number, cwd: string): JumpEntry {
  return {
    piSessionId: `scan:${pane.tmuxPaneId}`,
    cwd,
    tmuxSession: pane.tmuxSession,
    tmuxWindow: pane.tmuxWindow,
    tmuxPaneId: pane.tmuxPaneId,
    pid: piPid,
    lastSeen: new Date(pane.activity * 1000).toISOString(),
  };
}

export function dedupeByPane<T extends { tmuxPaneId: string; lastSeen: string }>(entries: T[]): T[] {
  const byPane = new Map<string, T>();
  for (const e of entries) {
    const existing = byPane.get(e.tmuxPaneId);
    if (!existing || e.lastSeen > existing.lastSeen) byPane.set(e.tmuxPaneId, e);
  }
  return [...byPane.values()];
}
