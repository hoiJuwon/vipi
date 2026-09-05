import { basename } from "node:path";
import { matchesKey, Key, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { DiscoveredEntry } from "./discover";
import { rowParts, type RowParts } from "./format";
import { fuzzyFilter } from "./fuzzy";
import { cleanPreview } from "./preview";
import { boxBottom, labelDivider } from "./box";

const LIST_ROWS = 10;
const PREVIEW_ROWS = 10;
const PREVIEW_CHROME_CROP = 4;

export interface JumpTheme {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
}

export type ExplorerAction =
  | { type: "jump"; entry: DiscoveredEntry }
  | { type: "new" }
  | { type: "rename"; entry: DiscoveredEntry; name: string }
  | { type: "close"; entry: DiscoveredEntry }
  | { type: "cancel" };

export interface SessionTreeOptions {
  entries: DiscoveredEntry[];
  currentPaneId?: string;
  rootLabel: string;
  getPreview: (paneId: string) => string | undefined;
  onDone: (action: ExplorerAction) => void;
  requestRender: () => void;
  theme: JumpTheme;
}

type Mode = "normal" | "filter" | "rename";

function padToWidth(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function padStartToWidth(text: string, width: number): string {
  return " ".repeat(Math.max(0, width - visibleWidth(text))) + text;
}

function isPrintableInput(data: string): boolean {
  return data.length > 0 && !/[\x00-\x1f\x7f]/u.test(data);
}

interface ColumnWidths {
  nameW: number;
  targetW: number;
  cwdW: number;
  ageW: number;
}

interface ColumnPlan {
  cwd: boolean;
  age: boolean;
}

export class SessionTreeOverlay {
  private mode: Mode = "normal";
  private query = "";
  private renameText = "";
  private selected = 0;
  private previewLines: string[] = [];
  private cachedFiltered?: DiscoveredEntry[];
  private done = false;
  private confirmClosePane?: string;
  private readonly widths: ColumnWidths;

  constructor(private readonly opts: SessionTreeOptions) {
    const parts = opts.entries.map((entry) => rowParts(entry, new Date(), opts.currentPaneId));
    this.widths = {
      nameW: Math.max(8, ...parts.map((row) => visibleWidth(row.name))),
      targetW: Math.max(6, ...parts.map((row) => visibleWidth(row.target))),
      cwdW: Math.max(3, ...parts.map((row) => visibleWidth(row.cwd))),
      ageW: Math.max(3, ...parts.map((row) => visibleWidth(row.age))),
    };
    this.loadPreview();
  }

  private filtered(): DiscoveredEntry[] {
    if (!this.cachedFiltered) {
      this.cachedFiltered = fuzzyFilter(
        this.query,
        this.opts.entries,
        (entry) => `${entry.name ?? basename(entry.cwd)} ${entry.cwd} ${entry.tmuxSession}`,
      );
    }
    return this.cachedFiltered;
  }

  private currentEntry(): DiscoveredEntry | undefined {
    const entries = this.filtered();
    if (entries.length === 0) return undefined;
    return entries[Math.min(this.selected, entries.length - 1)];
  }

  private finish(action: ExplorerAction): void {
    this.done = true;
    this.opts.onDone(action);
  }

  handleInput(data: string): void {
    if (this.done) return;

    if (this.mode === "filter") {
      this.handleFilterInput(data);
      return;
    }
    if (this.mode === "rename") {
      this.handleRenameInput(data);
      return;
    }

    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q") {
      this.finish({ type: "cancel" });
      return;
    }
    if (matchesKey(data, Key.enter) || data === "l") {
      const entry = this.currentEntry();
      if (entry) this.finish({ type: "jump", entry });
      return;
    }
    if (matchesKey(data, Key.up) || data === "k") {
      if (this.selected > 0) this.selected -= 1;
      this.afterNavigation();
      return;
    }
    if (matchesKey(data, Key.down) || data === "j") {
      if (this.selected < this.filtered().length - 1) this.selected += 1;
      this.afterNavigation();
      return;
    }
    if (data === "g") {
      this.selected = 0;
      this.afterNavigation();
      return;
    }
    if (data === "G") {
      this.selected = Math.max(0, this.filtered().length - 1);
      this.afterNavigation();
      return;
    }
    if (data === "/") {
      this.mode = "filter";
      this.confirmClosePane = undefined;
      this.opts.requestRender();
      return;
    }
    if (data === "n") {
      this.finish({ type: "new" });
      return;
    }
    if (data === "r") {
      const entry = this.currentEntry();
      if (!entry) return;
      this.mode = "rename";
      this.renameText = entry.name ?? basename(entry.cwd);
      this.confirmClosePane = undefined;
      this.opts.requestRender();
      return;
    }
    if (data === "x") {
      const entry = this.currentEntry();
      if (!entry) return;
      if (this.confirmClosePane === entry.tmuxPaneId) {
        this.finish({ type: "close", entry });
      } else {
        this.confirmClosePane = entry.tmuxPaneId;
        this.opts.requestRender();
      }
      return;
    }

    this.confirmClosePane = undefined;
    this.opts.requestRender();
  }

  private handleFilterInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.mode = "normal";
      this.opts.requestRender();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.mode = "normal";
      this.opts.requestRender();
      return;
    }
    if (matchesKey(data, Key.backspace)) {
      this.query = Array.from(this.query).slice(0, -1).join("");
      this.afterQueryChange();
      return;
    }
    if (matchesKey(data, Key.ctrl("u"))) {
      this.query = "";
      this.afterQueryChange();
      return;
    }
    if (isPrintableInput(data)) {
      this.query += data;
      this.afterQueryChange();
    }
  }

  private handleRenameInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.mode = "normal";
      this.renameText = "";
      this.opts.requestRender();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const entry = this.currentEntry();
      const name = this.renameText.replace(/\s+/gu, " ").trim();
      if (entry && name) this.finish({ type: "rename", entry, name });
      return;
    }
    if (matchesKey(data, Key.backspace)) {
      this.renameText = Array.from(this.renameText).slice(0, -1).join("");
      this.opts.requestRender();
      return;
    }
    if (matchesKey(data, Key.ctrl("u"))) {
      this.renameText = "";
      this.opts.requestRender();
      return;
    }
    if (isPrintableInput(data)) {
      this.renameText += data;
      this.opts.requestRender();
    }
  }

  private afterQueryChange(): void {
    this.cachedFiltered = undefined;
    this.selected = 0;
    this.afterNavigation();
  }

  private afterNavigation(): void {
    this.confirmClosePane = undefined;
    this.loadPreview();
    this.opts.requestRender();
  }

  private loadPreview(): void {
    const entry = this.currentEntry();
    if (!entry) {
      this.previewLines = ["(no live sessions under this root)"];
      return;
    }
    const raw = this.opts.getPreview(entry.tmuxPaneId);
    if (raw === undefined) {
      this.previewLines = ["(no preview)"];
      return;
    }
    let cleaned = cleanPreview(raw, PREVIEW_ROWS, PREVIEW_CHROME_CROP);
    if (cleaned.length === 0) cleaned = cleanPreview(raw, PREVIEW_ROWS, 0);
    this.previewLines = cleaned.length > 0 ? cleaned : ["(empty pane)"];
  }

  invalidate(): void {
    this.cachedFiltered = undefined;
  }

  render(width: number): string[] {
    const innerWidth = Math.max(0, width - 2);
    const theme = this.opts.theme;
    const input =
      this.mode === "filter"
        ? `/${this.query}█`
        : this.mode === "rename"
          ? `rename: ${this.renameText}█`
          : this.query
            ? `filter: ${this.query}`
            : `root: ${this.opts.rootLabel}`;

    return [
      this.renderTop(innerWidth),
      this.borderRow(theme.fg("text", padToWidth(truncateToWidth(input, innerWidth), innerWidth))),
      this.borderRow(theme.fg("border", "─".repeat(innerWidth))),
      ...this.renderListRows(innerWidth),
      this.renderPreviewLabel(innerWidth),
      ...this.renderPreviewRows(innerWidth),
      this.renderFooter(innerWidth),
      theme.fg("border", boxBottom(innerWidth)),
    ];
  }

  private renderTop(innerWidth: number): string {
    const theme = this.opts.theme;
    const title = " PI SESSIONS ";
    const fitted = visibleWidth(title) > innerWidth ? truncateToWidth(title, innerWidth) : title;
    const left = Math.max(0, Math.floor((innerWidth - visibleWidth(fitted)) / 2));
    const right = Math.max(0, innerWidth - visibleWidth(fitted) - left);
    return (
      theme.fg("border", `╭${"─".repeat(left)}`) +
      theme.fg("accent", fitted) +
      theme.fg("border", `${"─".repeat(right)}╮`)
    );
  }

  private borderRow(content: string): string {
    return this.opts.theme.fg("border", "│") + content + this.opts.theme.fg("border", "│");
  }

  private renderListRows(innerWidth: number): string[] {
    const theme = this.opts.theme;
    const entries = this.filtered();
    const selected = entries.length > 0 ? Math.min(this.selected, entries.length - 1) : -1;
    const contentWidth = Math.max(0, innerWidth - 2);
    const plan = this.columnPlan(contentWidth);
    const optionLines = entries.map((entry) =>
      this.renderRow(rowParts(entry, new Date(), this.opts.currentPaneId), contentWidth, plan),
    );

    let start = 0;
    if (optionLines.length > LIST_ROWS) {
      start = Math.min(Math.max(selected - Math.floor(LIST_ROWS / 2), 0), optionLines.length - LIST_ROWS);
    }

    const rows: string[] = [];
    for (let offset = 0; offset < LIST_ROWS; offset += 1) {
      const index = start + offset;
      const isSelected = entries.length > 0 && index === selected;
      const prefix = isSelected ? "→ " : "  ";
      const full = padToWidth(truncateToWidth(prefix + (optionLines[index] ?? ""), innerWidth), innerWidth);
      const styled = isSelected
        ? theme.bg("selectedBg", theme.fg("text", full))
        : entries[index]?.source === "scan"
          ? theme.fg("dim", full)
          : theme.fg("text", full);
      rows.push(this.borderRow(styled));
    }
    return rows;
  }

  private renderPreviewLabel(innerWidth: number): string {
    const entry = this.currentEntry();
    const label = entry
      ? `preview: ${entry.name ?? basename(entry.cwd)} (${entry.tmuxSession}:${entry.tmuxWindow})`
      : "preview";
    return this.borderRow(this.opts.theme.fg("muted", labelDivider(label, innerWidth)));
  }

  private renderPreviewRows(innerWidth: number): string[] {
    return Array.from({ length: PREVIEW_ROWS }, (_, index) => {
      const line = this.previewLines[index] ?? "";
      return this.borderRow(
        this.opts.theme.fg("muted", padToWidth(truncateToWidth(line, innerWidth), innerWidth)),
      );
    });
  }

  private renderFooter(innerWidth: number): string {
    const count = `${this.filtered().length}/${this.opts.entries.length}`;
    let hints = "j/k move · enter open · / filter · n new · r rename · x x close · q quit";
    if (this.mode === "filter") hints = "type to filter · enter accept · esc normal · ctrl+u clear";
    if (this.mode === "rename") hints = "type name · enter save · esc cancel · ctrl+u clear";
    if (this.confirmClosePane) hints = "press x again to close the selected live session";
    return this.borderRow(
      this.opts.theme.fg("muted", padToWidth(truncateToWidth(`${count}  ${hints}`, innerWidth), innerWidth)),
    );
  }

  private columnPlan(contentWidth: number): ColumnPlan {
    const separatorWidth = 3;
    const base = 2 + this.widths.nameW + separatorWidth + this.widths.targetW;
    if (base + separatorWidth + this.widths.cwdW + separatorWidth + this.widths.ageW <= contentWidth) {
      return { cwd: true, age: true };
    }
    if (base + separatorWidth + this.widths.ageW <= contentWidth) return { cwd: false, age: true };
    return { cwd: false, age: false };
  }

  private renderRow(parts: RowParts, contentWidth: number, plan: ColumnPlan): string {
    const separator = " │ ";
    const name =
      visibleWidth(parts.name) > this.widths.nameW
        ? truncateToWidth(parts.name, this.widths.nameW, "…")
        : padToWidth(parts.name, this.widths.nameW);
    const target = padStartToWidth(parts.target, this.widths.targetW);
    let row = `${parts.dot} ${name}${separator}${target}`;
    if (plan.cwd) row += separator + padToWidth(parts.cwd, this.widths.cwdW);
    if (plan.age) row += separator + padStartToWidth(parts.age, this.widths.ageW);

    if (visibleWidth(row) > contentWidth) {
      const coreWidth = visibleWidth(`${parts.dot} `) + separator.length + visibleWidth(target);
      const budget = Math.max(0, contentWidth - coreWidth);
      row = `${parts.dot} ${budget > 0 ? truncateToWidth(parts.name, budget, "…") : ""}${separator}${target}`;
    }
    return truncateToWidth(row, contentWidth, "…");
  }
}
