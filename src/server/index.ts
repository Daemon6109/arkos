// ─── Arkos HTTP Server ────────────────────────────────────────────────────────
// Persistent Node.js HTTP server. Claude delegates coding tasks here instead
// of writing code itself — saves API costs, runs on local 6900XT GPU.

import { run } from "../kernel/index.js";
import { getStats } from "../memory/index.js";
import { randomUUID } from "crypto";
import { createServer } from "http";
import type { IncomingMessage, ServerResponse } from "http";
import { readdirSync } from "fs";
import { join } from "path";

const OLLAMA_HOST = "172.30.176.1:11434";
const startTime = Date.now();

// ── Types ─────────────────────────────────────────────────────────────────────

interface RunJob {
  runId: string;
  goal: string;
  language: string;
  status: "queued" | "running" | "done" | "failed";
  score?: number;
  outputDir?: string;
  files?: string[];
  acceptancePassed?: boolean;
  error?: string;
  logs: string[];
  listeners: Set<(line: string) => void>;
  startedAt: number;
  finishedAt?: number;
}

// ── State ─────────────────────────────────────────────────────────────────────

const jobs = new Map<string, RunJob>();
let isRunning = false;
const jobQueue: string[] = [];

// ── Queue ─────────────────────────────────────────────────────────────────────

function pushLog(job: RunJob, line: string) {
  job.logs.push(line);
  job.listeners.forEach(fn => fn(line));
}

async function processQueue() {
  if (isRunning || jobQueue.length === 0) return;
  const runId = jobQueue.shift()!;
  const job = jobs.get(runId);
  if (!job) return;

  isRunning = true;
  job.status = "running";

  const origLog = console.log.bind(console);
  console.log = (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    origLog(line);
    pushLog(job, line);
  };

  try {
    await run(job.goal, { skipSimulation: true, language: job.language, verbose: false });

    const slug = job.goal.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
    const outputDir = `${process.env.HOME}/.arkos/output/${slug}`;

    const walk = (dir: string): string[] => {
      try {
        return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
          e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name).replace(outputDir + "/", "")]
        );
      } catch { return []; }
    };

    job.status = "done";
    job.outputDir = outputDir;
    job.files = walk(outputDir).filter(f => !f.includes("node_modules"));

    // Extract score from logs
    const scoreLine = [...job.logs].reverse().find(l => l.includes("Score:"));
    if (scoreLine) {
      const m = scoreLine.match(/Score:\s*([\d.]+)/);
      if (m) job.score = parseFloat(m[1]);
    }
    job.acceptancePassed = job.logs.some(l => l.includes("✅ All acceptance criteria met"));

  } catch (err) {
    job.status = "failed";
    job.error = String(err);
  } finally {
    console.log = origLog;
    job.finishedAt = Date.now();
    pushLog(job, "__DONE__");
    job.listeners.clear();
    isRunning = false;
    setTimeout(processQueue, 100);
  }
}

function submitJob(goal: string, language = "TypeScript"): string {
  const runId = randomUUID();
  const job: RunJob = {
    runId, goal, language, status: "queued",
    logs: [], listeners: new Set(), startedAt: Date.now(),
  };
  jobs.set(runId, job);
  jobQueue.push(runId);
  processQueue();
  return runId;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(data, null, 2));
}

// ── Server ────────────────────────────────────────────────────────────────────

export function startServer(port = 3847) {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const pathname = (req.url ?? "/").split("?")[0];
    const method = req.method ?? "GET";

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    // POST /run
    if (method === "POST" && pathname === "/run") {
      const body = JSON.parse(await readBody(req) || "{}") as any;
      const goal = String(body.goal ?? "").trim();
      if (!goal) return send(res, { error: "goal is required" }, 400);
      const runId = submitJob(goal, body.language ?? "TypeScript");
      return send(res, { runId, status: "queued" }, 202);
    }

    // GET /run/:id/stream  — SSE
    const streamMatch = pathname.match(/^\/run\/([^/]+)\/stream$/);
    if (method === "GET" && streamMatch) {
      const job = jobs.get(streamMatch[1]);
      if (!job) return send(res, { error: "not found" }, 404);

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });

      const emit = (line: string) => res.write(`data: ${line}\n\n`);

      // replay buffered logs
      for (const line of job.logs) emit(line);
      if (job.status === "done" || job.status === "failed") { res.end(); return; }

      job.listeners.add(emit);
      req.on("close", () => { job.listeners.delete(emit); res.end(); });
      return;
    }

    // GET /run/:id
    const runMatch = pathname.match(/^\/run\/([^/]+)$/);
    if (method === "GET" && runMatch) {
      const job = jobs.get(runMatch[1]);
      if (!job) return send(res, { error: "not found" }, 404);
      return send(res, {
        runId: job.runId, status: job.status, score: job.score,
        outputDir: job.outputDir, files: job.files,
        acceptancePassed: job.acceptancePassed, error: job.error,
        logLines: job.logs.length, startedAt: job.startedAt, finishedAt: job.finishedAt,
      });
    }

    // DELETE /run/:id — cancel queued job
    if (method === "DELETE" && runMatch) {
      const job = jobs.get(runMatch[1]);
      if (!job) return send(res, { error: "not found" }, 404);
      if (job.status === "queued") {
        const i = jobQueue.indexOf(job.runId);
        if (i !== -1) jobQueue.splice(i, 1);
        job.status = "failed"; job.error = "cancelled";
        return send(res, { ok: true });
      }
      return send(res, { error: "cannot cancel a running job" }, 409);
    }

    // GET /runs
    if (method === "GET" && pathname === "/runs") {
      const stats = getStats();
      const recent = [...jobs.values()]
        .sort((a, b) => b.startedAt - a.startedAt).slice(0, 10)
        .map(j => ({ runId: j.runId, goal: j.goal.slice(0, 60), status: j.status, score: j.score }));
      return send(res, { stats, recent });
    }

    // GET /status
    if (method === "GET" && pathname === "/status") {
      const stats = getStats();
      return send(res, {
        ok: true,
        uptime: Math.floor((Date.now() - startTime) / 1000),
        isRunning, queued: jobQueue.length,
        totalRuns: stats.total, avgScore: stats.avgScore,
        model: "qwen2.5-coder:14b / qwen3:14b",
        ollamaHost: OLLAMA_HOST, port,
      });
    }

    send(res, { error: "not found" }, 404);
  });

  server.listen(port, () => {
    console.log(`🚀 Arkos server on http://localhost:${port}`);
    console.log(`   POST   /run              submit a goal`);
    console.log(`   GET    /run/:id          job status + result`);
    console.log(`   GET    /run/:id/stream   SSE progress`);
    console.log(`   DELETE /run/:id          cancel queued job`);
    console.log(`   GET    /runs             recent history`);
    console.log(`   GET    /status           health check`);
  });

  return server;
}
