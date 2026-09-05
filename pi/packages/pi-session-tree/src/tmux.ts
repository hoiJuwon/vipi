export const LIST_PANES_FORMAT =
  "#{session_name}\t#{window_index}\t#{pane_id}\t#{pane_pid}\t#{window_activity}";
export const DISPLAY_FORMAT = "#S\t#I\t#{pane_id}";

export interface PaneInfo {
  tmuxSession: string;
  tmuxWindow: string;
  tmuxPaneId: string;
  pid: number;
  activity: number; // unix seconds
}

export function parseListPanes(output: string): PaneInfo[] {
  const panes: PaneInfo[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length !== 5) continue;
    const [tmuxSession, tmuxWindow, tmuxPaneId, pidStr, actStr] = parts;
    const pid = Number(pidStr);
    const activity = Number(actStr);
    if (!tmuxSession || !tmuxWindow || !tmuxPaneId || !Number.isFinite(pid) || !Number.isFinite(activity)) continue;
    panes.push({ tmuxSession, tmuxWindow, tmuxPaneId, pid, activity });
  }
  return panes;
}

export function parseDisplayMessage(
  output: string
): { tmuxSession: string; tmuxWindow: string; tmuxPaneId: string } | null {
  const parts = output.trim().split("\t");
  if (parts.length !== 3) return null;
  const [tmuxSession, tmuxWindow, tmuxPaneId] = parts;
  if (!tmuxSession || !tmuxWindow || !tmuxPaneId) return null;
  return { tmuxSession, tmuxWindow, tmuxPaneId };
}

export function jumpTarget(e: { tmuxSession: string; tmuxWindow: string }): string {
  return `${e.tmuxSession}:${e.tmuxWindow}`;
}
