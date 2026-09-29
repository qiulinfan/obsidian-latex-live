import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { delimiter, dirname, join } from "path";

const EXE = process.platform === "win32" ? ".exe" : "";

/** Common TeX bin directories; GUI apps on macOS get a minimal PATH. */
function candidateDirs(): string[] {
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return [
      join(local, "Programs", "MiKTeX", "miktex", "bin", "x64"),
      "C:\\texlive\\2026\\bin\\windows",
      "C:\\texlive\\2025\\bin\\windows",
    ];
  }
  return [
    "/Library/TeX/texbin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/texbin",
    "/usr/bin",
    join(homedir(), "bin"),
    join(homedir(), ".TinyTeX", "bin", "universal-darwin"),
    join(homedir(), ".TinyTeX", "bin", "x86_64-linux"),
  ];
}

/**
 * Directory containing the TeX binaries: the configured one, a common
 * install location, or whatever the login shell's PATH finds.
 */
export function resolveTexBinDir(configured: string): string | null {
  const probe = `pdflatex${EXE}`;
  const dirs = configured.trim() ? [configured.trim()] : candidateDirs();
  for (const d of dirs) {
    if (existsSync(join(d, probe))) return d;
  }
  if (configured.trim()) return null;
  const res = spawnSync(
    process.platform === "win32" ? "where.exe" : "/bin/sh",
    process.platform === "win32" ? ["pdflatex"] : ["-lc", "command -v pdflatex"],
    { encoding: "utf8", timeout: 4000 },
  );
  const found =
    res.status === 0
      ? res.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean)
      : undefined;
  return found ? dirname(found) : null;
}

/**
 * Environment for TeX processes: the bin dir first on PATH, and wide log
 * lines so file paths and messages are not wrapped at 79 columns.
 */
export function texEnv(binDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: [binDir, process.env.PATH ?? ""].filter(Boolean).join(delimiter),
    max_print_line: "10000",
    error_line: "254",
    half_error_line: "238",
  };
}

export function texTool(binDir: string, name: string): string {
  return join(binDir, name + EXE);
}
