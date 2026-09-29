import { ChildProcess, spawn } from "child_process";

export interface LspClientOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Log prefix. */
  name: string;
  /** Server -> client requests; the return value is the result (default null). */
  onRequest?: (method: string, params: unknown) => unknown;
  onNotification?: (method: string, params: unknown) => void;
  /** The process exited without stop() being called. */
  onExit?: (code: number | null) => void;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Minimal JSON-RPC client over a language server's stdio (Content-Length framing).
 * Knows nothing about LSP semantics; see texlab.ts for that.
 */
export class LspClient {
  private proc: ChildProcess | null = null;
  private buf: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private stopping = false;
  private exited: Promise<void> = Promise.resolve();

  constructor(private opts: LspClientOptions) {}

  get running(): boolean {
    return this.proc !== null;
  }

  /** Spawn the server. Rejects (and cleans up) when the binary cannot be started. */
  start(): Promise<void> {
    const proc = spawn(this.opts.command, this.opts.args ?? [], {
      cwd: this.opts.cwd,
      env: this.opts.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;
    this.exited = new Promise((resolve) => proc.once("close", () => resolve()));
    proc.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
    proc.stderr?.on("data", (chunk: Buffer) => {
      console.debug(`[${this.opts.name}]`, String(chunk).trimEnd());
    });
    proc.stdin?.on("error", () => {
      // EPIPE after the server died; the exit handler reports it.
    });
    proc.on("exit", (code) => {
      if (this.proc === proc) this.proc = null;
      this.rejectAll(new Error(`${this.opts.name} exited`));
      if (!this.stopping) this.opts.onExit?.(code);
    });
    return new Promise((resolve, reject) => {
      proc.once("spawn", () => resolve());
      proc.once("error", (err) => {
        if (this.proc === proc) this.proc = null;
        reject(err);
      });
    });
  }

  request(method: string, params: unknown, timeoutMs = 5000): Promise<unknown> {
    const proc = this.proc;
    if (!proc) return Promise.reject(new Error(`${this.opts.name} is not running`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params }, proc);
    });
  }

  notify(method: string, params: unknown): void {
    if (this.proc) this.write({ jsonrpc: "2.0", method, params }, this.proc);
  }

  /** shutdown + exit, then SIGKILL if the server is still alive after `graceMs`. */
  async stop(graceMs = 500): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.stopping = true;
    const killer = setTimeout(() => proc.kill("SIGKILL"), graceMs);
    try {
      await this.request("shutdown", null, graceMs);
      this.notify("exit", null);
    } catch {
      proc.kill("SIGKILL");
    }
    await this.exited;
    clearTimeout(killer);
    this.proc = null;
    this.stopping = false;
  }

  private rejectAll(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const headerEnd = this.buf.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const m = /Content-Length:\s*(\d+)/i.exec(this.buf.subarray(0, headerEnd).toString("ascii"));
      if (!m) {
        this.buf = this.buf.subarray(headerEnd + 4);
        continue;
      }
      const start = headerEnd + 4;
      const len = Number(m[1]);
      if (this.buf.length < start + len) return;
      const body = this.buf.subarray(start, start + len).toString("utf8");
      this.buf = this.buf.subarray(start + len);
      try {
        this.handle(JSON.parse(body));
      } catch (err) {
        console.error(`[${this.opts.name}] bad message:`, err);
      }
    }
  }

  private handle(msg: {
    id?: number;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: { message?: string };
  }): void {
    if (msg.method !== undefined && msg.id !== undefined) {
      let result: unknown = null;
      try {
        result = this.opts.onRequest?.(msg.method, msg.params) ?? null;
      } catch (err) {
        console.error(`[${this.opts.name}] ${msg.method} handler failed:`, err);
      }
      if (this.proc) this.write({ jsonrpc: "2.0", id: msg.id, result }, this.proc);
      return;
    }
    if (msg.method !== undefined) {
      try {
        this.opts.onNotification?.(msg.method, msg.params);
      } catch (err) {
        console.error(`[${this.opts.name}] ${msg.method} handler failed:`, err);
      }
      return;
    }
    if (msg.id === undefined) return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error.message ?? "LSP error"));
    else p.resolve(msg.result);
  }

  private write(msg: object, proc: ChildProcess): void {
    const json = JSON.stringify(msg);
    proc.stdin?.write(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`);
  }
}
