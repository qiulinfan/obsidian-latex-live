import type { Engine } from "../tex/project";

// The export report (design 5): what the export did and every place it fell back, for the
// completion Notice, the report modal (S7a) and `report.json` in the work folder.

export type ExportStage = "build" | "plan" | "probe" | "fragments" | "emit";

export type ReportKind =
  | "build"
  | "probe"
  | "fragment"
  | "math"
  | "numbering"
  | "ref"
  | "cite"
  | "image"
  | "code"
  | "unknown-macro"
  | "unknown-env";

export interface ReportItem {
  severity: "error" | "warning" | "info";
  kind: ReportKind;
  message: string;
  /** Absolute path of the source file, and its 1-based line. */
  file?: string;
  line?: number;
  /** How many times it happened (items of one kind and message merge). */
  count?: number;
}

/**
 * A number the emitter took from TeX, in document order: a probe step (an equation row, a box, a
 * caption, a footnote) or an equation's own `\tag` (counter `tag`); `shown` false for steps TeX
 * took back (an equation with its own \tag, the subequations parent). The fidelity tests compare
 * these with the probe's steps and the .aux.
 */
export interface ShownNumber {
  counter: string;
  /** What the page shows (texText of TeX's value). */
  value: string;
  shown: boolean;
  /** The label that names it, if any. */
  label?: string;
}

export interface ExportReport {
  /** The written file (set by the command), and its size. */
  output: string;
  bytes: number;
  engine: Engine;
  /** The look the export used (`elegantbook`, `standard`). */
  profile: string;
  timings: Record<ExportStage | "write", number>;
  /** What the HTML holds (headings, paragraphs, formulas, fragments, footnotes, font bytes, ...). */
  counts: Record<string, number>;
  /** The numbers the page shows (see ShownNumber). */
  numbers: ShownNumber[];
  items: ReportItem[];
}

/** Collects report items; the same kind and message without a place merge into one with a count. */
export class ReportBuilder {
  readonly items: ReportItem[] = [];
  private merged = new Map<string, ReportItem>();

  add(item: ReportItem): void {
    if (item.file === undefined && item.line === undefined) {
      const key = `${item.severity}|${item.kind}|${item.message}`;
      const seen = this.merged.get(key);
      if (seen) {
        seen.count = (seen.count ?? 1) + (item.count ?? 1);
        return;
      }
      this.merged.set(key, item);
    }
    this.items.push(item);
  }

  get warnings(): number {
    return this.items.filter((i) => i.severity !== "info").length;
  }
}

/** Bytes as the completion Notice shows them (`240 KB`, `1.0 MB`). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** One line for the completion Notice: `Exported main.html (1.0 MB, 3.1 s): 2 TeX fragments, 0 warnings`. */
export function reportSummary(r: ExportReport, name: string): string {
  const total = Object.values(r.timings).reduce((a, b) => a + b, 0);
  const fragments = r.counts.fragments ?? 0;
  const warnings = r.items.filter((i) => i.severity !== "info").length;
  return (
    `Exported ${name} (${formatBytes(r.bytes)}, ${(total / 1000).toFixed(1)} s): ` +
    `${fragments} TeX fragment${fragments === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}`
  );
}

/** The report as plain text, grouped by severity (report.json keeps the structure). */
export function formatReport(r: ExportReport): string {
  const lines = [
    `${r.output} (${formatBytes(r.bytes)}), ${r.engine}, profile ${r.profile}`,
    `timings: ${Object.entries(r.timings).map(([k, v]) => `${k} ${v} ms`).join(", ")}`,
    `counts: ${Object.entries(r.counts).map(([k, v]) => `${k} ${v}`).join(", ")}`,
  ];
  for (const severity of ["error", "warning", "info"] as const) {
    const items = r.items.filter((i) => i.severity === severity);
    if (!items.length) continue;
    lines.push(`${severity}s:`);
    for (const i of items) {
      const where = i.file ? ` (${i.file}${i.line ? `:${i.line}` : ""})` : "";
      lines.push(`  [${i.kind}] ${i.message}${i.count && i.count > 1 ? ` ×${i.count}` : ""}${where}`);
    }
  }
  return lines.join("\n");
}
