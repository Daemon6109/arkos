// ─── Requirement Extraction ───────────────────────────────────────────────────
// Pure string-parsing extraction of explicit deliverables from a goal string.
// No LLM — fast, deterministic, used to anchor the planner.

export interface Requirement {
  id: string;        // e.g. "cmd:ping", "file:index.ts", "feat:auth"
  type: "file" | "command" | "endpoint" | "feature" | "export";
  label: string;     // human-readable
  mustExist: boolean;
}

export interface RequirementSet {
  explicit: Requirement[];  // directly mentioned in the goal
  implicit: Requirement[];  // inferred (entry point, type defs, etc.)
  summary: string;          // one-line prompt injection string
}

// Known npm package names — never treat these as required files or commands
const KNOWN_NPM_PACKAGES = new Set([
  "discord.js", "react", "vue", "svelte", "express", "fastify", "hono",
  "axios", "chalk", "ora", "commander", "yargs", "minimist", "dotenv",
  "zod", "prisma", "drizzle", "typeorm", "mongoose", "sequelize",
  "lodash", "date-fns", "dayjs", "moment", "uuid", "nanoid",
  "bun", "node", "typescript", "tsx", "vite", "esbuild", "rollup",
  "jest", "vitest", "mocha", "biome", "eslint", "prettier",
  "inquirer", "kleur", "picocolors", "glob", "fast-glob", "fs-extra",
  "p-limit", "execa", "cross-env", "rimraf", "concurrently",
]);

// Discord.js event names — these are events not commands
const DISCORD_EVENTS = new Set([
  "interactionCreate", "messageCreate", "guildCreate", "guildDelete",
  "ready", "error", "warn", "debug", "shardReady", "voiceStateUpdate",
  "channelCreate", "channelDelete", "memberAdd", "memberRemove",
]);

// Common words that look like slash commands but aren't
const SLASH_FALSE_POSITIVES = new Set([
  "commands", "index", "src", "lib", "dist", "test", "tests",
  "config", "utils", "types", "models", "services", "handlers",
  "middleware", "routes", "controllers", "schemas",
  ...DISCORD_EVENTS,
]);

function langToExt(language: string): string {
  const map: Record<string, string> = {
    TypeScript: "ts", JavaScript: "js", Python: "py",
    Rust: "rs", Go: "go", Lua: "lua",
  };
  return map[language] ?? "ts";
}

export function extractRequirements(goal: string, language: string): RequirementSet {
  const explicit: Requirement[] = [];
  const seen = new Set<string>();

  function add(req: Requirement) {
    if (!seen.has(req.id)) {
      seen.add(req.id);
      explicit.push(req);
    }
  }

  // ── Slash commands: /word (but not URLs or known false positives) ──────────
  const cmdPattern = /(?<!:)\/([a-zA-Z][a-zA-Z0-9_-]*)/g;
  let match: RegExpExecArray | null;
  while ((match = cmdPattern.exec(goal)) !== null) {
    const name = match[1];
    // Skip known non-command patterns
    if (SLASH_FALSE_POSITIVES.has(name) || KNOWN_NPM_PACKAGES.has(name)) continue;
    // Skip if it looks like a file path segment (has a following /)
    const afterMatch = goal.slice(match.index + match[0].length);
    if (afterMatch.startsWith("/")) continue;
    add({
      id: `cmd:${name}`,
      type: "command",
      label: `/${name} command`,
      mustExist: true,
    });
  }

  // ── Named files: src/foo.ts, index.ts, .env, README, etc. ────────────────
  const filePattern = /(?:src\/[\w/.-]+\.\w+|[\w.-]+\.(?:ts|js|py|rs|go|lua|json|env|md|yaml|yml|toml)|\.env(?:\.\w+)?|README(?:\.\w+)?)/gi;
  while ((match = filePattern.exec(goal)) !== null) {
    const filePath = match[0];
    // Skip known npm package names masquerading as files
    const baseName = filePath.split("/").pop()?.replace(/\.\w+$/, "") ?? "";
    if (KNOWN_NPM_PACKAGES.has(filePath) || KNOWN_NPM_PACKAGES.has(baseName)) continue;
    // Skip package.json, tsconfig.json, biome.json — assembly generates these
    if (/^(package|tsconfig|biome|bun\.lock)/.test(baseName)) continue;
    add({
      id: `file:${filePath}`,
      type: "file",
      label: filePath,
      mustExist: true,
    });
  }

  // ── API endpoints: GET /, POST /, PUT /, DELETE /, REST ──────────────────
  const httpPattern = /\b(GET|POST|PUT|DELETE|PATCH)\s+(\/[\w/:-]*)/gi;
  while ((match = httpPattern.exec(goal)) !== null) {
    const method = match[1].toUpperCase();
    const path = match[2];
    const id = `endpoint:${method}:${path}`;
    add({
      id,
      type: "endpoint",
      label: `${method} ${path}`,
      mustExist: true,
    });
  }
  // REST keyword
  if (/\bREST\b/i.test(goal)) {
    add({ id: "endpoint:rest", type: "endpoint", label: "REST API", mustExist: true });
  }

  // ── Exports: "export X", "exports: X", "exports X" ───────────────────────
  const exportPattern = /exports?:?\s+([\w$]+)/gi;
  while ((match = exportPattern.exec(goal)) !== null) {
    const name = match[1];
    add({
      id: `export:${name}`,
      type: "export",
      label: `export ${name}`,
      mustExist: false,
    });
  }

  // ── Implicit requirements ─────────────────────────────────────────────────
  const implicit: Requirement[] = [];
  const ext = langToExt(language);

  // Always: entry point
  implicit.push({
    id: `file:src/index.${ext}`,
    type: "file",
    label: `src/index.${ext} (entry point)`,
    mustExist: true,
  });

  // If multiple explicit files are mentioned, add type definitions file for TS/JS
  const explicitFiles = explicit.filter((r) => r.type === "file");
  if (explicitFiles.length > 1 && (ext === "ts" || ext === "js")) {
    implicit.push({
      id: `file:src/types.${ext}`,
      type: "file",
      label: `src/types.${ext} (type definitions)`,
      mustExist: false,
    });
  }

  // ── Build summary string ──────────────────────────────────────────────────
  const parts: string[] = [];

  const commands = explicit.filter((r) => r.type === "command");
  const files = explicit.filter((r) => r.type === "file");
  const endpoints = explicit.filter((r) => r.type === "endpoint");
  const exports_ = explicit.filter((r) => r.type === "export");

  if (commands.length > 0) parts.push(...commands.map((r) => r.label));
  if (files.length > 0) parts.push(...files.map((r) => r.label));
  if (endpoints.length > 0) parts.push(...endpoints.map((r) => r.label));
  if (exports_.length > 0) parts.push(...exports_.map((r) => r.label));

  const summary = parts.length > 0
    ? `Required: ${parts.join(", ")}`
    : "No explicit requirements detected";

  return { explicit, implicit, summary };
}
