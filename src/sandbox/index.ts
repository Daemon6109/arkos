// ─── Sandbox ─────────────────────────────────────────────────────────────────
// Scoped execution environment for workers.
// Uses Docker if available, falls back to restricted subprocess in project dir.
// Workers can run commands, read/write files, install packages, check types.

import { exec as execCb } from "child_process";
import { promisify } from "util";
import { readFile, writeFile, readdir, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { existsSync } from "fs";

const execAsync = promisify(execCb);

const BUN_BIN = process.env.HOME + "/.bun/bin";

// Commands workers are allowed to run
const COMMAND_WHITELIST = [
  "bun", "bunx", "tsc", "biome",
  "ls", "cat", "echo", "mkdir", "cp", "mv",
  "grep", "find", "wc",
];

const EXEC_TIMEOUT_MS = 30_000;

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  success: boolean;
}

export interface SandboxInfo {
  mode: "docker" | "subprocess";
  projectDir: string;
  language: string;
}

export class Sandbox {
  readonly projectDir: string;
  readonly language: string;
  readonly mode: "docker" | "subprocess";
  private dockerContainerId?: string;

  constructor(projectDir: string, language: string) {
    this.projectDir = projectDir;
    this.language = language;
    this.mode = "subprocess"; // Docker support added later
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async setup(): Promise<void> {
    await mkdir(this.projectDir, { recursive: true });
    await mkdir(join(this.projectDir, "src"), { recursive: true });
  }

  async teardown(): Promise<void> {
    if (this.dockerContainerId) {
      await this.rawExec(`docker rm -f ${this.dockerContainerId}`).catch(() => {});
    }
  }

  info(): SandboxInfo {
    return { mode: this.mode, projectDir: this.projectDir, language: this.language };
  }

  // ── Command execution ─────────────────────────────────────────────────────

  async exec(cmd: string): Promise<ExecResult> {
    // Safety: check command is whitelisted
    const baseCmd = cmd.trim().split(/\s+/)[0];
    const isAllowed = COMMAND_WHITELIST.some(
      (allowed) => baseCmd === allowed || baseCmd.endsWith(`/${allowed}`)
    );

    if (!isAllowed) {
      return {
        stdout: "",
        stderr: `Blocked: '${baseCmd}' is not in the allowed command list`,
        exitCode: 1,
        success: false,
      };
    }

    return this.rawExec(cmd);
  }

  private async rawExec(cmd: string): Promise<ExecResult> {
    try {
      const { stdout, stderr } = await execAsync(cmd, {
        cwd: this.projectDir,
        timeout: EXEC_TIMEOUT_MS,
        env: {
          ...process.env,
          PATH: `${BUN_BIN}:${process.env.PATH}`,
        },
      });
      return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0, success: true };
    } catch (err: any) {
      return {
        stdout: err.stdout?.trim() ?? "",
        stderr: err.stderr?.trim() ?? err.message ?? String(err),
        exitCode: err.code ?? 1,
        success: false,
      };
    }
  }

  // ── File operations ───────────────────────────────────────────────────────

  async readFile(relativePath: string): Promise<string | null> {
    try {
      return await readFile(join(this.projectDir, relativePath), "utf-8");
    } catch {
      return null;
    }
  }

  async writeFile(relativePath: string, content: string): Promise<void> {
    const fullPath = join(this.projectDir, relativePath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
  }

  async listFiles(subdir = ""): Promise<string[]> {
    const dir = join(this.projectDir, subdir);
    if (!existsSync(dir)) return [];
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.map((e) => join(subdir, e.name));
  }

  // ── High-level tools ──────────────────────────────────────────────────────

  async installDeps(): Promise<ExecResult> {
    return this.exec("bun install");
  }

  async typeCheck(): Promise<ExecResult> {
    return this.exec("bunx tsc --noEmit");
  }

  async runTests(testPath = "tests/"): Promise<ExecResult> {
    const result = await this.rawExec(`bun test ${testPath} 2>&1 || true`);
    return { ...result, success: !result.stderr.includes("error:") };
  }

  async lint(): Promise<ExecResult> {
    return this.exec("bunx biome check --apply src/");
  }

  async runFile(filePath: string): Promise<ExecResult> {
    const ext = filePath.split(".").pop() ?? "";
    if (!["ts", "js", "py"].includes(ext)) {
      return { stdout: "", stderr: "Unsupported file type", exitCode: 1, success: false };
    }
    const cmd = ext === "py" ? `python3 ${filePath}` : `bun ${filePath}`;
    return this.exec(cmd);
  }

  async checkFileExists(relativePath: string): Promise<boolean> {
    return existsSync(join(this.projectDir, relativePath));
  }
}

// ─── Tool result formatting ───────────────────────────────────────────────────
// Formats sandbox output for model consumption — concise, signal over noise.

export function formatToolResult(tool: string, result: ExecResult): string {
  const status = result.success ? "✓" : "✗";
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").slice(0, 1500);
  return `[${status} ${tool}]\n${output || "(no output)"}`;
}

export function extractErrors(result: ExecResult): string[] {
  const combined = [result.stdout, result.stderr].join("\n");
  return combined
    .split("\n")
    .filter((line) =>
      line.includes("error") ||
      line.includes("Error") ||
      line.includes("FAIL") ||
      line.includes("✗")
    )
    .slice(0, 20);
}
