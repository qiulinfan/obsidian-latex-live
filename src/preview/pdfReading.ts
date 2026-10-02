import { promises as fs } from "fs";
import { randomUUID } from "crypto";
import { basename, dirname, extname, join } from "path";

/** Only links meant for an external browser/mail/phone application. PDF actions never execute. */
export function externalPdfUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return ["https:", "http:", "mailto:", "tel:"].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

export interface PdfSaveIo {
  choose(defaultPath: string): Promise<string | null>;
  write(path: string, bytes: Uint8Array): Promise<void>;
}

export async function atomicPdfWrite(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  await fs.mkdir(dirname(path), { recursive: true });
  try {
    await fs.writeFile(temporary, bytes, { flag: "wx" });
    await fs.rename(temporary, path);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

/** Copy the last successful PDF before the dialog: a later compile/root switch cannot alter it. */
export async function savePdfSnapshot(root: string, bytes: Uint8Array, io: PdfSaveIo = desktopPdfSaveIo()): Promise<string | null> {
  const snapshot = bytes.slice();
  const proposed = root.slice(0, root.length - extname(root).length) + ".pdf";
  const chosen = await io.choose(proposed);
  if (!chosen) return null;
  const target = /\.pdf$/i.test(chosen) ? chosen : `${chosen}.pdf`;
  await io.write(target, snapshot);
  return target;
}

function desktopPdfSaveIo(): PdfSaveIo {
  return {
    choose: async (defaultPath) => {
      let remote: {
        getCurrentWindow(): unknown;
        dialog: { showSaveDialog(window: unknown, options: unknown): Promise<{ canceled: boolean; filePath?: string }> };
      } | undefined;
      try { remote = (require("electron") as { remote?: typeof remote }).remote; } catch { remote = undefined; }
      if (!remote?.dialog) throw new Error("The desktop save dialog is unavailable.");
      const result = await remote.dialog.showSaveDialog(remote.getCurrentWindow(), {
        defaultPath,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
        properties: ["createDirectory", "showOverwriteConfirmation"],
      });
      return result.canceled ? null : result.filePath ?? null;
    },
    write: atomicPdfWrite,
  };
}

export async function openPdfExternal(value: string): Promise<void> {
  const url = externalPdfUrl(value);
  if (!url) return;
  try {
    const shell = (require("electron") as { shell?: { openExternal(url: string): Promise<void> } }).shell;
    if (shell) await shell.openExternal(url);
  } catch { /* A restricted host cannot launch an external application. */ }
}
