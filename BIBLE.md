# ARKOS — The Architecture Bible

> A cognitive AI operating system. Local. Modular. Vision-first.

---

## 0. What This Is

Arkos is not a model. It is not a chatbot. It is not another LLM wrapper.

Arkos is a **cognitive architecture** — an orchestration layer that coordinates specialized local models to think, plan, simulate, execute, and learn. The goal is to produce an AI that can be handed a high-level goal and return a finished, human-centered product without constant hand-holding.

The core insight driving Arkos:

> **Architectural intelligence outperforms model scale.**  
> A well-orchestrated system of 7B models can outperform a single 70B model on complex, goal-driven tasks.

---

## 1. Philosophy

### 1.1 Vision Before Prediction
Standard LLMs predict the next token. They don't know what they're building. Arkos flips this: before any generation begins, the system forms a **vision** — a high-level design of the goal. Everything downstream is expansion and refinement of that vision, not blind prediction.

### 1.2 Human-Centered Simulation
The system imagines real users interacting with whatever it's building. Not abstract correctness — actual human friction, confusion, and delight. Goals are derived from simulated experience, not just from the prompt.

### 1.3 Adaptive Compute
Context is expensive. Arkos defaults to minimal context per task and only escalates when a confidence threshold is missed. No token dumps. No wasted inference.

### 1.4 Local First
No cloud dependency. No data leaving the machine. Arkos is designed to run on consumer/prosumer hardware with small specialized models. Privacy is a first-class constraint, not an afterthought.

### 1.5 No Training Required (v1)
Arkos leverages existing open-weight models (Mistral, CodeLlama, Qwen, Phi, etc.) as workers. The intelligence lives in the orchestration, routing, and memory — not in novel model weights. Training may come later for fine-tuned specialists.

---

## 2. Architecture Overview

```
User Prompt / Seed
       │
       ▼
 ┌─────────────┐
 │   Vision    │  ← Creates design blueprint from prompt + memory
 │  Generator  │
 └──────┬──────┘
        │
        ▼
 ┌─────────────────┐
 │    Scenario     │  ← Simulates user personas interacting with vision
 │    Simulator    │
 └──────┬──────────┘
        │
        ▼
 ┌─────────────┐
 │    Goal     │  ← Extracts ranked, impact-weighted goals from simulation
 │  Extractor  │
 └──────┬──────┘
        │
        ▼
 ┌──────────────────┐
 │  Feasibility     │  ← Checks if goals are technically/logically doable
 │    Checker       │
 └──────┬───────────┘
        │
        ▼
 ┌─────────────┐
 │   Planner   │  ← Builds ordered task graph with worker assignments
 └──────┬──────┘
        │
        ▼
 ┌────────────────────────────────────────┐
 │              Task Graph                │
 │  [task1] → [task2] → [task3] → ...    │
 └──────┬─────────────────────────────────┘
        │
        ▼
 ┌─────────────────┐
 │ Execution Pool  │  ← Parallel specialized workers (code, debug, docs...)
 └──────┬──────────┘
        │
        ▼
 ┌─────────────────┐
 │    Evaluator    │  ← Scores output; triggers context escalation if needed
 │     / Critic    │
 └──────┬──────────┘
        │
        ▼
 ┌─────────────┐
 │   Memory    │  ← Stores lessons, patterns, simulation results, decisions
 └─────────────┘
```

---

## 3. Module Specifications

### 3.1 Vision Generator

**Purpose:** Transform a user prompt into a structured internal design representation.

**Input:** Raw prompt + relevant memory  
**Output:** Vision object (features, UX flow, architecture, constraints)

**Behavior:**
- Does NOT generate code or content
- Produces a mental model of the finished thing
- Informed by memory (past lessons, past simulations, known patterns)
- Output is a structured JSON-like representation, not freeform text

**Example:**
```
Prompt: "Build a plugin manager for OpenClaw"

Vision Output:
{
  "name": "Plugin Manager",
  "components": ["install", "list", "enable/disable", "update"],
  "ux_flow": ["user discovers plugin → installs → sees in list → toggles"],
  "tech_constraints": ["local file system", "npm registry or local store"],
  "success_metrics": ["< 3 clicks to install", "visible status", "no config editing"]
}
```

---

### 3.2 Scenario Simulator

**Purpose:** Simulate real humans using the envisioned product. Derive friction, confusion, and delight points.

**Input:** Vision object  
**Output:** Scenario results per persona (friction score, blockers, goals)

**Personas (default set, user-extensible):**
- `novice` — no tech background, first time user
- `hobbyist` — some software experience, not a developer
- `developer` — technical, wants control and power

**Simulation format:**
```
Persona: novice
Step 1: Opens plugin manager → sees list of plugins
Step 2: Tries to install → clicks button → sees no feedback
Step 3: Confused → closes window
Friction: HIGH at install confirmation
Blocker: No loading state / success signal
```

**Output scores per persona:**
- `friction` (0–10)
- `time_to_success` (estimated steps)
- `confusion_points` (list)
- `delight_points` (list)

---

### 3.3 Goal Extractor

**Purpose:** Convert simulation outcomes into ranked, actionable goals.

**Input:** Scenario results  
**Output:** Prioritized goal list

**Scoring factors:**
- Impact (how many personas affected?)
- Severity (blocker vs. annoyance)
- Feasibility hint (from simulation context)

**Example output:**
```
Goals (ranked):
1. Add install feedback / loading state — HIGH impact, novice + hobbyist blocked
2. Show success confirmation — MEDIUM impact
3. Add search/filter — LOW impact, developer only
```

---

### 3.4 Feasibility Checker

**Purpose:** Validate that each goal is technically achievable given constraints.

**Input:** Goal list + known project context  
**Output:** Goal list with feasibility flags + effort estimates

**Checks:**
- Is this goal implementable with the current tech stack?
- Are there dependencies that must be resolved first?
- Estimated complexity: `low / medium / high`

Goals marked `infeasible` are flagged for human review, not silently dropped.

---

### 3.5 Planner

**Purpose:** Generate a structured task graph from the feasible goal list.

**Input:** Feasible goal list + vision object  
**Output:** Ordered task graph with worker assignments

**Task graph properties:**
- Tasks have explicit dependencies (`task_b depends_on task_a`)
- Each task specifies which worker executes it
- Tasks can run in parallel when no dependencies exist
- Max depth is bounded to prevent infinite planning

**Example:**
```
Task Graph:
  T1: Scaffold plugin manager module (worker: code_gen)
  T2: Implement install command (worker: code_gen, depends: T1)
  T3: Add loading state UI (worker: code_gen, depends: T1)
  T4: Write unit tests (worker: tester, depends: T2, T3)
  T5: Update docs (worker: doc_writer, depends: T4)
```

---

### 3.6 Execution Pool

**Purpose:** Run tasks using specialized worker models.

**Workers (v1):**

| Worker | Model | Responsibility |
|---|---|---|
| `code_gen` | CodeLlama / Qwen-Coder | Write code from task spec |
| `debugger` | Mistral / Qwen | Identify and patch errors |
| `doc_writer` | Small general LLM | Generate documentation |
| `file_ops` | Script / tool | Read, write, move files |
| `test_runner` | Tool + LLM | Execute tests, interpret results |
| `context_retriever` | Embedding model | Pull relevant memory/docs |

**Worker behavior:**
- Receives task spec + minimal context
- Executes using available tools (file read/write, shell, etc.)
- Returns output + raw confidence score (0.0–1.0)
- Does NOT loop internally — one pass, result to evaluator

**Parallelism:**
Workers for independent tasks run simultaneously. Dependency-blocked tasks wait. Workers can interrupt and request context from `context_retriever` mid-task.

---

### 3.7 Evaluator / Critic

**Purpose:** Score worker outputs and decide next action.

**Input:** Worker output + task spec + goals  
**Output:** Score + action (`accept` / `retry_with_context` / `replan` / `escalate`)

**Scoring dimensions:**
- `correctness` — does output solve the task?
- `goal_alignment` — does it match the original goal?
- `efficiency` — is it unnecessarily complex?
- `ux_impact` — does it match simulated user expectations?

**Adaptive context loop:**
```
Worker output received
    │
    ▼
Evaluator scores output
    │
    ├─ score ≥ threshold → ACCEPT → next task
    │
    └─ score < threshold
            │
            ├─ attempt < max_retries
            │       │
            │       ▼
            │   Expand context (memory retrieval + more plan info)
            │   Retry worker with expanded context
            │
            └─ attempt ≥ max_retries → REPLAN or ESCALATE
```

**Key design rule:** No infinite retries. Bounded by `max_retries` (default: 3). On failure, escalate to human or replan.

---

### 3.8 Memory System

**Purpose:** Persistent knowledge base that improves system performance over time.

**Storage layers:**

| Layer | Type | Content |
|---|---|---|
| Short-term | In-memory / session | Current task context, conversation |
| Long-term | Vector DB (Qdrant/Chroma) | Past simulations, lessons, patterns |
| Project | File-based | Project structure, decisions, history |

**Stored artifacts:**
- Simulation results per persona per project type
- Task outputs marked as accepted/rejected
- Lessons (e.g., "novice users need explicit success feedback")
- Architecture decisions and rationale

**Memory influences:**
- Vision Generator pulls past lessons when forming visions
- Context Retriever surfaces relevant memory for stuck workers
- Scenario Simulator uses past persona behavior patterns

---

## 4. Data Flow — Full Example

**Goal:** "Build a command-line onboarding experience for OpenClaw"

```
1. Vision Generator:
   → CLI flow: welcome → account setup → first project → success
   → Key constraint: < 5 steps, no config file editing

2. Scenario Simulator (novice persona):
   → Step 1: runs `openclaw init` → sees wall of text → confused
   → Friction: information overload at init
   → Delight: step-by-step prompt felt guided

3. Goal Extractor:
   → G1: replace wall of text with step-by-step wizard
   → G2: add progress indicator
   → G3: auto-detect sensible defaults

4. Feasibility Checker:
   → G1: feasible, medium effort
   → G2: feasible, low effort
   → G3: feasible, medium effort

5. Planner:
   → T1: scaffold wizard CLI module
   → T2: implement step 1 (account)
   → T3: implement step 2 (project)
   → T4: add progress bar
   → T5: auto-detect defaults
   → T6: integration test
   → T7: update docs

6. Execution:
   → code_gen writes T1, T2, T3 in parallel
   → code_gen adds T4, T5
   → tester runs T6
   → doc_writer writes T7

7. Evaluator:
   → T3 confidence low → retry with expanded context (existing init code)
   → T6 test fails → debugger patches error
   → All tasks accepted

8. Memory:
   → Stores: "novice users overwhelmed by init output → wizard pattern resolved it"
```

---

## 5. Tech Stack

### Core Orchestrator
- **Language:** Rust (performance, safety, async) or Node.js (speed of iteration)
- **Task queue:** `tokio` async workers (Rust) or `bull` / native async (Node)
- **IPC between workers:** JSON over local socket or shared message bus

### Model Inference
- **Runtime:** [Ollama](https://ollama.ai) — runs local models, handles GPU/CPU switching
- **Models (v1 suggested):**
  - Vision/Planner: `mistral:7b` or `qwen2.5:7b`
  - Code worker: `qwen2.5-coder:7b` or `codellama:7b`
  - Critic: `phi3:mini` or `mistral:7b`
  - Embeddings: `nomic-embed-text`

### Memory
- **Vector DB:** [Qdrant](https://qdrant.tech) (local, fast, REST API)
- **Project state:** JSON files per project in workspace

### Tools (worker-callable)
- `read_file(path)` → returns file content
- `write_file(path, content)` → writes file
- `run_shell(cmd)` → executes shell command, returns stdout/stderr
- `search_codebase(query)` → semantic search over project files
- `retrieve_memory(query)` → vector search over memory DB

---

## 6. Key Design Rules

1. **Vision before action.** No worker executes before a vision and plan exist.
2. **Bounded retries.** Max 3 retries per task. Escalate, don't loop.
3. **Minimal context by default.** Workers start with task spec + minimal context. Escalate on low confidence.
4. **Structured scoring.** Critic uses multi-dimensional scores, not binary like/dislike.
5. **No silent drops.** Failed goals and tasks are surfaced to memory and optionally to the user.
6. **Personas are explicit.** Simulation uses defined personas, not vague "user" assumptions.
7. **Memory is mandatory.** Every run produces memory artifacts. The system learns.
8. **Parallel when possible.** Independent tasks always run in parallel.
9. **Human escalation path.** The system knows when to stop and ask.

---

## 7. v1 Scope (MVP)

The first working version should demonstrate the core loop:

```
Prompt → Vision → Plan → Execute (1–2 workers) → Evaluate → Output
```

**MVP milestones:**

- [ ] Orchestrator kernel (accepts prompt, manages state)
- [ ] Vision generator (prompt → design spec via LLM)
- [ ] Planner (design spec → task list)
- [ ] Code worker (task → code output via Ollama)
- [ ] File tool (read/write)
- [ ] Evaluator (basic scoring, retry logic)
- [ ] Memory stub (JSON file, upgradeable to vector DB)
- [ ] CLI interface (run arkos "do this thing")

Scenario simulation and advanced memory come in v2.

---

## 8. Future Directions

- **Fine-tuned specialists:** Train small models on specific task types (e.g., Roblox TypeScript codegen)
- **Token confidence routing:** Intercept low-confidence token regions mid-generation, call specialist
- **Multi-project memory:** Cross-project lesson sharing
- **UI surface:** Web dashboard for monitoring task graphs in real time
- **Voice interface:** Seed prompts via voice
- **Self-improvement loop:** Arkos evaluates its own architecture decisions and proposes improvements

---

## 9. What Arkos Is NOT

- Not a new model
- Not a cloud service
- Not a chatbot
- Not another AutoGPT clone (no infinite loops, no tool soup)
- Not dependent on any single provider

---

*Bible v0.1 — drafted 2026-03-08*
