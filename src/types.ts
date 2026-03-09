// ─── Core Types ───────────────────────────────────────────────────────────────

export interface VisionObject {
  name: string;
  description: string;
  components: string[];
  uxFlow: string[];
  techConstraints: string[];
  successMetrics: string[];
  rawVision: string;
}

export type WorkerType =
  | "code_gen"
  | "debugger"
  | "doc_writer"
  | "test_runner"
  | "file_ops"
  | "refactor_analyzer"
  | "refactor_planner"
  | "refactor_executor";

export type TaskStatus = "pending" | "running" | "complete" | "failed" | "escalated";

export interface Task {
  id: string;
  description: string;
  worker: WorkerType;
  dependsOn: string[];
  context: { files: string[]; notes: string };
  status: TaskStatus;
  targetFile?: string;    // exact file this task writes — set by planner
  exports?: string[];     // symbols this task exports (for import wiring)
}

export interface FileMapEntry {
  path: string;           // e.g. "src/scanner.ts"
  description: string;    // what this file contains
  exports: string[];      // symbols it exports
}

export interface TaskGraph {
  goal: string;
  tasks: Task[];
  fileMap: FileMapEntry[]; // full project file structure decided upfront
  language: string;
}

export interface TaskResult {
  taskId: string;
  output: string;
  confidence: number;
  worker: WorkerType;
}

export type EvalAction = "accept" | "retry_with_context" | "replan" | "escalate";

export interface TaskEvaluation {
  taskId: string;
  correctness: number;
  goalAlignment: number;
  efficiency: number;
  uxImpact: number;
  overall: number;
  action: EvalAction;
  notes: string;
}

export interface RunEvaluation {
  taskEvaluations: TaskEvaluation[];
  overallScore: number;
  passed: boolean;
  summary: string;
}

// ─── Simulator Types ──────────────────────────────────────────────────────────

export type TechLevel = "novice" | "hobbyist" | "developer";

export interface Persona {
  name: string;
  description: string;
  techLevel: TechLevel;
}

export interface SimulationStep {
  step: number;
  action: string;
  outcome: string;
  friction: number;   // 0-10
  confusion: number;  // 0-10
}

export interface PersonaSimulation {
  persona: Persona;
  steps: SimulationStep[];
  overallFriction: number;
  overallConfusion: number;
  timeToSuccess: number;
  blockers: string[];
  delights: string[];
}
