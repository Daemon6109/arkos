// ─── Finalize Types ───────────────────────────────────────────────────────────

export type TodoType =
  | "import_cleanup"     // local file that duplicates something in a dep package
  | "service_incomplete" // service/controller that exists but appears to be a stub
  | "service_missing"    // service in reference that has no counterpart in target
  | "networking_issue"   // wrong networking pattern (not using @flamework/networking)
  | "type_cleanup"       // local type file that should come from dep package
  | "dependency_unused"  // dep in package.json but never imported anywhere in src
  | "flamework_pattern"; // doesn't use Flamework decorators correctly

export interface TodoItem {
  id: string;                   // unique slug e.g. "import-cleanup-server-time"
  type: TodoType;
  priority: "critical" | "high" | "medium" | "low";
  title: string;                // short description
  description: string;          // what needs to be done
  targetFile?: string;          // which file in target repo needs changing
  referenceFile?: string;       // equivalent file in reference repo
  suggestedChange?: string;     // brief description of the change
  estimatedComplexity: "trivial" | "simple" | "moderate" | "complex";
}

export interface FinalizeReport {
  targetRepo: string;
  analyzedAt: string;  // ISO timestamp
  totalItems: number;
  items: TodoItem[];
}

export interface FinalizeOptions {
  target: string;           // owner/repo
  reference?: string;       // owner/repo
  deps: string[];           // owner/repo[]
  analyzeOnly?: boolean;
  verbose?: boolean;
}
