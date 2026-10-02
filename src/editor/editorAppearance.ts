/** Local typography overrides for one LaTeX editor or its tooltip portal. */
export interface EditorAppearance {
  /** 0 follows Obsidian's text size; other values are pixels. */
  editorFontSize: number;
  /** 0 follows the theme; other values are unitless line-height multipliers. */
  editorLineHeight: number;
  /** An empty value follows Obsidian's monospace font. */
  editorFontFamily: string;
  /** MathJax formula size relative to the editor's text size. */
  mathPreviewScale: number;
}

/**
 * Apply only this container's CSS variables. Clearing an override restores inheritance;
 * the caller owns editor measurement and composition timing, with no state or build work.
 */
export function applyEditorAppearance(container: HTMLElement, settings: EditorAppearance): void {
  const style = container.style;
  const override = (name: string, value: string | null) => {
    if (value === null) style.removeProperty(name);
    else style.setProperty(name, value);
  };
  const fontSize = optionalNumber(settings.editorFontSize, 10, 40);
  const lineHeight = optionalNumber(settings.editorLineHeight, 1.1, 2.4);
  const fontFamily = typeof settings.editorFontFamily === "string" ? settings.editorFontFamily.trim() : "";
  const scale = typeof settings.mathPreviewScale === "number" && Number.isFinite(settings.mathPreviewScale)
    ? Math.min(2, Math.max(0.5, settings.mathPreviewScale)) : 1;
  override("--font-text-size", fontSize === null ? null : `${fontSize}px`);
  // Tooltip/card text has its own inherited size. Only an explicit editor size changes
  // their formula baseline, so the default keeps the host's existing math typography.
  override("--ll-editor-math-font-size", fontSize === null ? null : `${fontSize}px`);
  override("--line-height-normal", lineHeight === null ? null : String(lineHeight));
  override("--ll-editor-font-family", fontFamily || null);
  override("--ll-math-preview-scale", scale === 1 ? null : String(scale));
}

function optionalNumber(value: number, min: number, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(max, Math.max(min, value)) : null;
}
