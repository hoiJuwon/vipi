import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

export interface JumpEntry {
  piSessionId: string;
  sessionFile?: string;
  name?: string;
  topic?: string;
  named?: boolean;
  status?: "idle" | "working";
  unread?: boolean;
  cwd: string;
  tmuxSession: string;
  tmuxWindow: string;
  tmuxPaneId: string;
  pid: number;
  createdAt?: string;
  lastSeen: string;
}

function isJumpEntry(entry: unknown): entry is JumpEntry {
  if (typeof entry !== "object" || entry === null) return false;
  const value = entry as Record<string, unknown>;
  return (
    typeof value.piSessionId === "string" &&
    (value.sessionFile === undefined || typeof value.sessionFile === "string") &&
    (value.name === undefined || typeof value.name === "string") &&
    (value.topic === undefined || typeof value.topic === "string") &&
    (value.named === undefined || typeof value.named === "boolean") &&
    (value.status === undefined || value.status === "idle" || value.status === "working") &&
    (value.unread === undefined || typeof value.unread === "boolean") &&
    typeof value.cwd === "string" &&
    typeof value.tmuxSession === "string" &&
    typeof value.tmuxWindow === "string" &&
    typeof value.tmuxPaneId === "string" &&
    typeof value.pid === "number" &&
    (value.createdAt === undefined || typeof value.createdAt === "string") &&
    typeof value.lastSeen === "string"
  );
}

export function loadRegistry(path: string): JumpEntry[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    const entries = (raw as { entries?: unknown })?.entries;
    return Array.isArray(entries) ? entries.filter(isJumpEntry) : [];
  } catch {
    return [];
  }
}

export function saveRegistry(path: string, entries: JumpEntry[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  try {
    writeFileSync(temporary, JSON.stringify({ entries }, null, 2), { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {}
  }
}

function asDormant(entry: JumpEntry): JumpEntry {
  return {
    ...entry,
    status: "idle",
    unread: false,
    tmuxSession: "",
    tmuxWindow: "",
    tmuxPaneId: `session:${entry.piSessionId}`,
    pid: 0,
  };
}

export function upsertEntry(entries: JumpEntry[], entry: JumpEntry): JumpEntry[] {
  const next: JumpEntry[] = [];
  let inserted = false;
  for (const candidate of entries) {
    if (candidate.piSessionId === entry.piSessionId) {
      if (!inserted) {
        next.push(entry);
        inserted = true;
      }
      continue;
    }

    // A tree-created pane is shown immediately with a provisional ID. Replace
    // that placeholder in place once Pi publishes its real session ID/file.
    if (candidate.piSessionId.startsWith("pending:") && candidate.tmuxPaneId === entry.tmuxPaneId) {
      continue;
    }

    // /resume can replace the session inside a still-live pane. Preserve the
    // previous session as dormant instead of dropping it from the tree.
    if (entry.tmuxPaneId.startsWith("%") && candidate.tmuxPaneId === entry.tmuxPaneId) {
      next.push(asDormant(candidate));
    } else {
      next.push(candidate);
    }
  }
  if (!inserted) next.push(entry);
  return next;
}
