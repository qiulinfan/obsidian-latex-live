import { execFile, spawnSync } from "child_process";
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

const biberChecks = new Map<string, Promise<string | null>>();

/**
 * A biber that runs, for latexmk's full builds: the one in `binDir`, else the
 * first working one in another candidate directory (MacTeX 2026's universal
 * biber only prints lipo's usage on some Macs, and latexmk would take it from
 * PATH). Null when none runs. Checked once per bin dir.
 */
export function workingBiber(
  binDir: string,
  others: string[] = candidateDirs(),
): Promise<string | null> {
  const dirs = [binDir, ...others.filter((d) => d !== binDir)];
  const key = dirs.join(delimiter);
  let found = biberChecks.get(key);
  if (!found) {
    found = (async () => {
      for (const dir of dirs) {
        const bin = texTool(dir, "biber");
        if (existsSync(bin) && (await biberRuns(bin))) return bin;
      }
      return null;
    })();
    biberChecks.set(key, found);
  }
  return found;
}

function biberRuns(bin: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    // The first run of a packed biber unpacks itself, which takes a while.
    execFile(bin, ["--version"], { timeout: 30_000 }, (err, stdout) =>
      resolvePromise(!err && /biber version/i.test(stdout)),
    );
  });
}
