# Arkos

> A cognitive AI operating system. Local. Modular. Vision-first.

Arkos is not another LLM wrapper. It's an orchestration engine that coordinates specialized local models to **think, plan, simulate, execute, and learn** — autonomously.

## Core Idea

Standard LLMs predict the next token. They don't know what they're building.

Arkos flips this:

```
Prompt → Vision → Simulate Users → Extract Goals → Plan → Execute → Evaluate → Learn
```

The intelligence lives in the architecture, not the model size.

## Architecture

```
User Prompt
     │
     ▼
Vision Generator        ← forms a design before any code is written
     │
     ▼
Scenario Simulator      ← imagines real users interacting with the product
     │
     ▼
Goal Extractor          ← derives goals from simulated friction + delight
     │
     ▼
Feasibility Checker
     │
     ▼
Planner                 ← builds ordered task graph
     │
     ▼
Execution Pool          ← parallel specialized workers (code, debug, docs)
     │
     ▼
Evaluator / Critic      ← scores output; triggers adaptive context escalation
     │
     ▼
Memory                  ← persistent lessons + patterns
```

## Key Principles

- **Vision before action** — no worker runs without a plan
- **Adaptive context** — minimal context by default, escalate on low confidence
- **Bounded retries** — max 3 attempts, then escalate (no infinite loops)
- **Parallel execution** — independent tasks always run simultaneously
- **Local first** — no cloud, no API keys, no data leaving the machine
- **Memory mandatory** — every run produces artifacts the system learns from

## Tech Stack

- **Orchestrator:** Rust / Node.js
- **Models:** Ollama (Mistral, Qwen-Coder, CodeLlama, Phi)
- **Memory:** Qdrant vector DB
- **Tools:** file read/write, shell exec, semantic codebase search

## Status

🚧 Early development — see `BIBLE.md` for full architecture spec.

## Docs

- [BIBLE.md](./BIBLE.md) — full architecture specification
- [docs/](./docs/) — module-level docs (in progress)
