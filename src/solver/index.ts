// ─── AIDE-style Solution Tree ─────────────────────────────────────────────────
// Instead of one linear execution attempt, maintain a solution tree where
// failed branches can be explored further and the best solution wins.
//
// SolutionSolver caps total nodes to avoid infinite expansion.
// Each branch re-executes only failed tasks with expanded context.
// getBestNode() returns the highest-scoring node across all branches.

import type { Task, TaskResult } from "../types.js";

// ─── Interfaces ───────────────────────────────────────────────────────────────

interface SolutionNode {
  id: string;
  parentId: string | null;
  attempt: number;
  score: number;
  passed: boolean;
  results: TaskResult[];
  failedTasks: string[];       // task IDs that scored below threshold
  contextExpansions: string[]; // what extra context was added vs parent
  children: string[];          // child node IDs
}

interface SolutionTree {
  nodes: Map<string, SolutionNode>;
  bestNodeId: string | null;
  root: string;
}

// ─── SolutionSolver ───────────────────────────────────────────────────────────

export class SolutionSolver {
  private tree: SolutionTree;
  private maxNodes: number;
  private nodeCounter: number;

  constructor(maxNodes = 5) {
    this.maxNodes = maxNodes;
    this.nodeCounter = 0;
    this.tree = {
      nodes: new Map(),
      bestNodeId: null,
      root: "",
    };
  }

  /** Create the root node from the first execution attempt. */
  createRoot(results: TaskResult[], score: number, passed: boolean): SolutionNode {
    const id = `node-${++this.nodeCounter}`;
    const node: SolutionNode = {
      id,
      parentId: null,
      attempt: 1,
      score,
      passed,
      results,
      failedTasks: [],
      contextExpansions: [],
      children: [],
    };
    this.tree.nodes.set(id, node);
    this.tree.root = id;
    this._updateBest(node);
    return node;
  }

  /**
   * Returns true if branching is worthwhile:
   *   - node hasn't passed the threshold
   *   - score is > 0.4 (worth trying to fix, not a total failure)
   *   - tree still has room for more nodes
   */
  shouldBranch(node: SolutionNode): boolean {
    return (
      !node.passed &&
      node.score > 0.4 &&
      this.tree.nodes.size < this.maxNodes
    );
  }

  /**
   * Create a child branch node from a parent.
   * The caller should update score/passed/results after re-execution
   * by calling updateNode().
   */
  createBranch(parent: SolutionNode, failedTasks: Task[], expansionHint: string): SolutionNode {
    const id = `node-${++this.nodeCounter}`;
    const node: SolutionNode = {
      id,
      parentId: parent.id,
      attempt: parent.attempt + 1,
      score: 0,
      passed: false,
      results: [],
      failedTasks: failedTasks.map((t) => t.id),
      contextExpansions: [...parent.contextExpansions, expansionHint],
      children: [],
    };
    parent.children.push(id);
    this.tree.nodes.set(id, node);
    // Note: _updateBest will be called again via updateNode() with real score
    return node;
  }

  /** Update a node's score/passed/results after re-execution and re-evaluate best. */
  updateNode(node: SolutionNode, score: number, passed: boolean, results: TaskResult[]): void {
    node.score = score;
    node.passed = passed;
    node.results = results;
    this._updateBest(node);
  }

  /** Returns the node with the highest score across all branches. */
  getBestNode(): SolutionNode | null {
    if (!this.tree.bestNodeId) return null;
    return this.tree.nodes.get(this.tree.bestNodeId) ?? null;
  }

  /**
   * Returns a context string to prepend on retry:
   * "Previous attempt scored X. Failed tasks: Y, Z. Focus on: <hint>"
   */
  getExpansionContext(node: SolutionNode): string {
    const failedNames = node.failedTasks.join(", ") || "unknown";
    const latestHint =
      node.contextExpansions.length > 0
        ? node.contextExpansions[node.contextExpansions.length - 1]
        : "improve output quality";
    return `Previous attempt scored ${node.score.toFixed(2)}. Failed tasks: ${failedNames}. Focus on: ${latestHint}`;
  }

  /** Total nodes explored so far. */
  get size(): number {
    return this.tree.nodes.size;
  }

  private _updateBest(node: SolutionNode): void {
    if (!this.tree.bestNodeId) {
      this.tree.bestNodeId = node.id;
      return;
    }
    const current = this.tree.nodes.get(this.tree.bestNodeId);
    if (!current || node.score > current.score) {
      this.tree.bestNodeId = node.id;
    }
  }
}

// ─── mergeResults ─────────────────────────────────────────────────────────────
// Takes base results, replaces any task that appears in overrides with the
// override version if the override has a higher confidence score.

export function mergeResults(base: TaskResult[], overrides: TaskResult[]): TaskResult[] {
  const merged = [...base];
  for (const override of overrides) {
    const idx = merged.findIndex((r) => r.taskId === override.taskId);
    if (idx >= 0) {
      if (override.confidence > merged[idx].confidence) {
        merged[idx] = override;
      }
    } else {
      merged.push(override);
    }
  }
  return merged;
}
