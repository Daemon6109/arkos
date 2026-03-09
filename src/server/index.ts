// ─── Arkos HTTP Server ────────────────────────────────────────────────────────
// Runs Arkos as a persistent service. Claude delegates coding tasks here
// instead of generating code itself — saves API costs, uses local 6900XT GPU.

import { run } from "../kernel/index.js";
import { getStats } from "../memory/index.js";
import { randomUUID } from "crypto";

const OLLAMA_HOST = "172.30.176.1:11434";
const startTime = Date.now();

// ── Job tracking ──────────────────────────────────────────────────────────────

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
  logListeners: Set<(line: string) => void>;
  startedAt: number;
  finishedAt?: number;
}

const jobs = new Map<string, RunJob>();
let isRunning = false;
const queue: string[] = [];

// ── Console capture ───────────────────────────────────────────────────────────

function captureConsoleTo(job: RunJob) {
  const original = console.log.bind(console);
  console.log = (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    original(line);
    job.logs.push(line);
    job.logListeners.forEach(fn => fn(line));
  };
  return () => { console.log = original; };
}

// ── Job queue ─────────────────────────────────────────────────────────────────

async function processQueue() {
  if (isRunning || queue.length === 0) return;
  const runId = queue.shift()!;
  const job = jobs.get(runId);
  if (!job) return;

  isRunning = true;
  job.status = "running";
  const restore = captureConsoleTo(job);

  try {
    await run(job.goal, {
      skipSimulation: true,
      language: job.language,
      verbose: false,
    });

    // Pull result from latest output dir
    const slug = job.goal
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60);
    const outputDir = `${process.env.HOME}/.arkos/output/${slug}`;

    let files: string[] = [];
    try {
      const { readdirSync } = await import("fs");
      const { join } = await import("path");
      const walk = (dir: string): string[] => {
        try {
          return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
            e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name).replace(outputDir + "/", "")]
          );
        } catch { return []; }
      };
      files = walk(outputDir).filter(f => !f.includes("node_modules"));
    } catch {}

    job.status = "done";
    job.outputDir = outputDir;
    job.files = files;
    job.finishedAt = Date.now();

  } catch (err) {
    job.status = "failed";
    job.error = String(err);
    job.finishedAt = Date.now();
  } finally {
    restore();
    isRunning = false;
    // Notify all SSE listeners the stream is done
    job.logListeners.forEach(fn => fn("__DONE__"));
    job.logListeners.clear();
    processQueue(); // pick up next job
  }
}

// ── Route handlers ────────────────────────────────────────────────────────────

function handleStatus() {
  return Response.json({
    ok: true,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    model: "qwen2.5-coder:14b / qwen3:14b",
    ollamaHost: OLLAMA_HOST,
    activeJob: isRunning,
    queueLength: queue.length,
  });
}

function handlePostRun(body: { goal: string; language?: string; sim?: boolean }) {
  const runId = randomUUID();
  const job: RunJob = {
    runId,
    goal: body.goal,
    language: body.language ?? "TypeScript",
    status: "queued",
    logs: [],
    logListeners: new Set(),
    startedAt: Date.now(),
  };
  jobs.set(runId, job);
  queue.push(runId);
  processQueue();
  return Response.json({ runId, status: "queued" }, { status: 202 });
}

function handleGetRun(runId: string) {
  const job = jobs.get(runId);
  if (!job) return Response.json({ error: "not found" }, { status: 404 });
  const { logListeners, ...safe } = job;
  return Response.json(safe);
}

function handleStreamRun(runId: string) {
  const job = jobs.get(runId);
  if (!job) return Response.json({ error: "not found" }, { status: 404 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      // Send buffered logs first
      for (const line of job.logs) {
        controller.enqueue(encoder.encode(`data: ${line}\n\n`));
      }

      if (job.status === "done" || job.status === "failed") {
        controller.enqueue(encoder.encode(`data: __DONE__\n\n`));
        controller.close();
        return;
      }

      const listener = (line: string) => {
        if (line === "__DONE__") {
          controller.enqueue(encoder.encode(`data: __DONE__\n\n`));
          controller.close();
          job.logListeners.delete(listener);
        } else {
          controller.enqueue(encoder.encode(`data: ${line}\n\n`));
        }
      };
      job.logListeners.add(listener);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function handleGetRuns() {
  const stats = getStats();
  const recent = Array.from(jobs.values())
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 10)
    .map(({ logListeners, logs: _logs, ...j }) => j);
  return Response.json({ stats, recent });
}

function handleDeleteRun(runId: string) {
  const job = jobs.get(runId);
  if (!job) return Response.json({ error: "not found" }, { status: 404 });
  if (job.status === "queued") {
    const idx = queue.indexOf(runId);
    if (idx !== -1) queue.splice(idx, 1);
    job.status = "failed";
    job.error = "Cancelled";
    return Response.json({ cancelled: true });
  }
  return Response.json({ error: "Cannot cancel a running job" }, { status: 409 });
}

// ── Server ────────────────────────────────────────────────────────────────────

export function startServer(port = 3847) {
  const server = Bun.serve({
    port,
    async fetch(req: Request) {
      const url = new URL(req.url);
      const path = url.pathname;

      // CORS preflight
      if (req.method === "OPTIONS") {
        return new Response(null, {
          headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,DELETE" },
        });
      }

      if (req.method === "GET" && path === "/status") return handleStatus();
      if (req.method === "GET" && path === "/runs") return handleGetRuns();

      if (req.method === "POST" && path === "/run") {
        const body = await req.json().catch(() => ({}));
        if (!body.goal) return Response.json({ error: "goal is required" }, { status: 400 });
        return handlePostRun(body);
      }

      const runMatch = path.match(/^\/run\/([^/]+)(\/stream)?$/);
      if (runMatch) {
        const runId = runMatch[1];
        if (runMatch[2] === "/stream") return handleStreamRun(runId);
        if (req.method === "GET") return handleGetRun(runId);
        if (req.method === "DELETE") return handleDeleteRun(runId);
      }

      return Response.json({ error: "not found" }, { status: 404 });
    },
  });

  console.log(`🚀 Arkos server running at http://localhost:${port}`);
  console.log(`   POST /run          — submit a coding goal`);
  console.log(`   GET  /run/:id      — check job status`);
  console.log(`   GET  /run/:id/stream — stream live progress`);
  console.log(`   GET  /runs         — recent run history`);
  console.log(`   GET  /status       — server health`);
  console.log(`\n   GPU: AMD 6900XT via Ollama at ${OLLAMA_HOST}`);
  console.log(`   Models: qwen2.5-coder:14b (code) · qwen3:14b (planning)`);
  return server;
}
