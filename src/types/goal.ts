/**
 * Goal system types — 4-layer goal hierarchy for task-oriented agent execution.
 *
 * Layer 1: User Goal (user's raw intent, immutable)
 * Layer 2: Operational Goal (agent's refined execution contract)
 * Layer 3: Sub Goals (DAG-structured task breakdown)
 * Layer 4: Immediate Goal (current action target, runtime only)
 *
 * Plus: evaluation context for environment-aware assessment,
 * drift detection for goal alignment monitoring.
 *
 * All types are engine-agnostic — they define the shape of the data,
 * not any specific execution model.
 */

import type { UUID } from 'crypto'

// ============================================================================
// Branded IDs
// ============================================================================

/** Branded type for goal identifiers. */
export type GoalId = string & { readonly __brand: 'GoalId' }

/** Cast a raw string to GoalId. Prefer createGoalId() when possible. */
export function asGoalId(id: string): GoalId {
  return id as GoalId
}

// ============================================================================
// Goal Hierarchy Types
// ============================================================================

/** User's raw intent — the source of truth. Never modified after creation. */
export interface UserGoal {
  readonly id: GoalId
  readonly text: string
  readonly createdAt: number
  readonly updatedAt: number
}

/** Agent-refined execution contract. The working agreement between user intent
 *  and agent behavior. Derived from UserGoal by the planning layer. */
export interface OperationalGoal {
  readonly id: GoalId
  readonly text: string
  readonly derivedFrom: GoalId // references UserGoal.id
  readonly constraints: readonly string[]
  readonly successCriteria: readonly string[]
  readonly createdAt: number
}

/** SubGoal status — the state machine for individual DAG nodes. */
export type SubGoalStatus =
  | 'pending'
  | 'active'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'skipped'

/** A single node in the goal DAG. Represents one actionable unit of work.
 *  Dependencies define the partial order — a node is only ready when all
 *  its upstream dependencies are completed. */
export interface SubGoal {
  readonly id: string // DAG node ID (not branded — short human-readable key)
  readonly parentId: GoalId // back-reference to owning OperationalGoal
  text: string // mutable — agent may refine description
  status: SubGoalStatus
  readonly dependencies: readonly string[] // upstream subgoal IDs
  assignedPlanId?: string // optional link to a Plan slug
  progress: number // 0-100
  readonly createdAt: number
  updatedAt: number
}

/** Current action target — runtime only, not persisted. Declared each turn
 *  by the agent to signal what it's working on right now. */
export interface ImmediateGoal {
  readonly subGoalId: string // which SubGoal this action serves
  readonly action: string // concrete description of current step
  readonly declaredAt: number
}

// ============================================================================
// DAG Types
// ============================================================================

/** In-memory DAG representation. Nodes map and edge list for fast traversal.
 *  readyQueue is computed on-demand via topological sort. */
export interface GoalDag {
  nodes: Map<string, SubGoal>
  edges: ReadonlyArray<[string, string]> // [from, to] dependency pairs
  readyQueue: string[] // cached topo-sorted ready node IDs
}

/** Operations that mutate the DAG structure. Each operation triggers a
 *  re-computation of the ready queue and topological order. */
export type DagOperation =
  | { type: 'add'; node: SubGoal; after?: string }
  | { type: 'remove'; nodeId: string }
  | { type: 'merge'; sourceIds: string[]; target: SubGoal }
  | { type: 'reorder'; nodeId: string; newDeps: string[] }
  | { type: 'updateStatus'; nodeId: string; status: SubGoalStatus }

// ============================================================================
// Goal State — the full in-memory representation
// ============================================================================

/** Complete goal state. Persisted to .claude/goals/<id>.json.
 *  This is the single source of truth (SSOT) for goal tracking. */
export interface GoalState {
  activeGoalId: GoalId | null
  userGoal: UserGoal | null
  operationalGoal: OperationalGoal | null
  dag: GoalDag
  immediateGoal: ImmediateGoal | null
  progress: number // overall completion percentage 0-100
  artifacts: string[] // file paths produced during execution
  metrics: GoalMetrics
}

/** Metrics tracked across the goal lifecycle. Separated from the main data
 *  so they can be serialized independently for analytics. */
export interface GoalMetrics {
  totalSubGoals: number
  completedSubGoals: number
  iterationCount: number
  maxIterations: number
  evalHistory: GoalEvalHistory
}

/** Drift and staleness tracking. Used to detect when the evaluator keeps
 *  reporting the same gap — triggers circuit breaker after 3 repeats. */
export interface GoalEvalHistory {
  lastGap: string | null
  consecutiveSameGapCount: number
}

// ============================================================================
// Evaluation Context — what the evaluator can observe
// ============================================================================

/** Snapshot of agent execution environment. Gathered after each action
 *  to feed the evaluator's rule engine and semantic checks. */
export interface EvaluationContext {
  toolResults: ToolResult[]
  fileDiffs: FileDiff[]
  testOutputs: TestOutput[]
  compileOutputs: CompileOutput[]
  gitStatus: GitStatus
  fileList: string[]
  errorLogs: ErrorLog[]
}

/** A single tool invocation result. Extracted from the conversation transcript
 *  or post-tool-use hook output. */
export interface ToolResult {
  toolName: string
  toolInput: Record<string, unknown>
  toolOutput: string // raw output text
  success: boolean
  timestamp: number
}

/** File change detected during or after a tool execution. Minimal
 *  representation — just path + change type + line count. */
export interface FileDiff {
  path: string
  added: number
  removed: number
  changed: number
}

/** Test execution output. Parsed from tool results where the tool is a test
 *  runner (e.g., `npm test`, `bun test`, `pytest`). */
export interface TestOutput {
  command: string
  exitCode: number
  stdout: string
  stderr: string
  passed: boolean
}

/** Compilation / build output. Parsed from tool results where the tool is a
 *  compiler or build system (e.g., `tsc`, `bun build`, `cmake`). */
export interface CompileOutput {
  command: string
  exitCode: number
  stdout: string
  stderr: string
  passed: boolean
}

/** Git working tree status snapshot. */
export interface GitStatus {
  staged: string[]
  unstaged: string[]
  untracked: string[]
  branch: string
  clean: boolean
}

/** Recent error log entries from the in-memory ring buffer. */
export interface ErrorLog {
  error: string
  timestamp: string
}

// ============================================================================
// Evaluation Result — output of the evaluation pipeline
// ============================================================================

/** Result from the evaluator after checking goal progress. Satisfied if the
 *  current state meets the goal condition; otherwise carries gap info for
 *  the next iteration. */
export interface EvalResult {
  satisfied: boolean
  level: EvalLevel
  reason: string
  gap: string | null
  evidence: EvalEvidence[]
}

/** Evaluation depth — which tier produced this result. */
export type EvalLevel = 'rule' | 'semantic' | 'final'

/** One piece of evidence gathered during evaluation. Links a finding to its
 *  source with a relevance score for downstream weighting. */
export interface EvalEvidence {
  source: string // file path, tool name, or context key
  finding: string // what was observed
  relevanceScore: number // how relevant to the goal (0-1)
}

// ============================================================================
// Rule Engine — pluggable deterministic checks
// ============================================================================

/** A rule is a pure function: given context and a target sub-goal, produce
 *  evidence. Rules are composable — the engine runs all registered rules and
 *  aggregates their output. */
export type RuleCheck = (ctx: EvaluationContext, goal: SubGoal) => EvalEvidence[]

// ============================================================================
// Drift Detection — alignment monitoring
// ============================================================================

/** Drift assessment result. Computed periodically to check if the agent's
 *  current behavior aligns with the operational goal. */
export interface DriftAssessment {
  consistencyScore: number // 0-100, higher = more aligned
  currentAction: string
  targetSubGoal: string
  operationalGoal: string
  trend: DriftTrend
  warnings: DriftWarning[]
}

export type DriftTrend = 'stable' | 'improving' | 'declining'

/** A single warning generated when drift is detected. Carries severity and
 *  a suggested action for the agent to take. */
export interface DriftWarning {
  severity: DriftSeverity
  message: string
  suggestedAction: DriftAction
}

export type DriftSeverity = 'low' | 'medium' | 'high'
export type DriftAction = 'continue' | 'replan' | 'stop'

// ============================================================================
// GoalStore — the state management interface
// ============================================================================

/** State management contract for goal tracking. Implementations provide
 *  in-memory storage with file persistence. This interface defines what
 *  the rest of the system can depend on. */
export interface GoalStore {
  // === DAG Operations ===

  addSubGoal(node: SubGoal): void
  removeSubGoal(nodeId: string): void
  updateSubGoalStatus(nodeId: string, status: SubGoalStatus): void
  reorderDependency(nodeId: string, newDeps: readonly string[]): void
  mergeSubGoals(sourceIds: string[], target: SubGoal): void

  // === Goal Lifecycle ===

  setUserGoal(text: string): GoalId
  setOperationalGoal(text: string): void
  setImmediateGoal(subGoalId: string, action: string): void
  clearImmediateGoal(): void

  // === Progress ===

  recalculateProgress(): number
  incrementIteration(): void
  recordEvalGap(gap: string | null): void

  // === Query ===

  getReadySubGoals(): SubGoal[]
  getActiveSubGoals(): SubGoal[]
  getBlockedSubGoals(): SubGoal[]
  getCompletedSubGoals(): SubGoal[]

  // === Persistence ===

  /** Serialize to JSON for persistence. */
  toJSON(): GoalState
  /** Load state from disk (overwrites current). */
  load(state: GoalState): void
  /** Reset to empty state. */
  clear(): void

  // === Accessors ===

  hasActiveGoal(): boolean
  getState(): GoalState
}
