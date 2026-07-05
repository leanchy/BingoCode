/**
 * GoalStore — in-memory state manager for the 4-layer goal hierarchy.
 *
 * Replaces the flat goal fields previously in bootstrap/state.ts with a
 * structured, queryable state object. Provides both mutation and query
 * APIs, plus signal-based change notification for React hooks.
 *
 * Architecture:
 *   GoalStore (this module) — in-memory singleton, synchronous mutations
 *   GoalPersistence (goalPersistence.ts) — disk I/O for save/load
 *   GoalDag (goalDag.ts) — DAG engine for topological operations
 */

import type { GoalState, SubGoal, SubGoalStatus, GoalId } from '../types/goal.js'
import { asGoalId } from '../types/goal.js'
import { randomUUID } from '../utils/crypto.js'
import { createSignal } from '../utils/signal.js'
import { saveGoalState, loadGoalState, getGoalFilePath, ensureGoalsDir, archiveGoal, deleteGoal, readVersion, saveIfUnchanged } from '../utils/goalPersistence.js'
import { GoalDagEngine } from '../utils/goalDag.js'
import { assessDrift } from '../utils/goalDrift.js'

// ============================================================================
// Module state
// ============================================================================

/** In-memory goal state. */
let store: GoalState = createEmptyGoalState()
/** Signal emitter for change notification (React hook subscription). */
const goalChanged = createSignal<[GoalState]>()
/** DAG engine — single source of truth for sub-goal graph operations. */
const dagEngine = new GoalDagEngine()
/** Current on-disk version. Used for optimistic concurrency control. */
let currentVersion = 0

/** Create a fresh empty goal state with all defaults. */
export function createEmptyGoalState(): GoalState {
  return {
    activeGoalId: null,
    userGoal: null,
    operationalGoal: null,
    dag: { nodes: new Map(), edges: [], readyQueue: [] },
    immediateGoal: null,
    progress: 0,
    artifacts: [],
    metrics: {
      totalSubGoals: 0,
      completedSubGoals: 0,
      iterationCount: 0,
      maxIterations: 20,
      evalHistory: { lastGap: null, consecutiveSameGapCount: 0 },
    },
  }
}

// ============================================================================
// Signal — for React hook subscription
// ============================================================================

/** Subscribe to goal state changes. Returns unsubscribe function.
 *  Used by useGoalStore hook in React components. */
export const onGoalStateChanged = goalChanged.subscribe

// ============================================================================
// Accessors
// ============================================================================

export function getState(): GoalState {
  return store
}

/** Alias for consumer code that imports getGoalState instead of getState. */
export const getGoalState = getState

export function getActiveGoalId(): GoalId | null {
  return store.activeGoalId
}

export function hasActiveGoal(): boolean {
  return store.activeGoalId !== null
}

/** Alias for consumer code that imports clearState instead of clear. */
export const clearState = clear

// ============================================================================
// Mutations
// ============================================================================

/** Set a new user goal. Creates an ID, marks the timestamp, and updates
 *  the active goal reference. Returns the new goal ID for downstream use. */
export function setUserGoal(text: string): GoalId {
  const id = asGoalId(randomUUID())
  store.activeGoalId = id
  store.userGoal = {
    id,
    text,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  store.operationalGoal = null // reset — will be refined later
  store.dag = { nodes: new Map(), edges: [], readyQueue: [] }
  store.immediateGoal = null
  store.progress = 0
  store.artifacts = []
  store.metrics = { ...createEmptyGoalState().metrics }

  // Reset the DAG engine too — new goal starts with a clean graph
  dagEngine.reset()

  emit()
  return id
}

/** Set the operational goal. The caller (typically the planning agent)
 *  refines the user goal into an executable contract. */
export function setOperationalGoal(text: string): void {
  if (!store.userGoal) {
    throw new Error('Cannot set operational goal without a user goal')
  }
  store.operationalGoal = {
    id: store.userGoal.id,
    text,
    derivedFrom: store.userGoal.id,
    constraints: [],
    successCriteria: [],
    createdAt: Date.now(),
  }
  emit()
}

/** Declare the current immediate action target. Updates the runtime
 *  pointer to which sub-goal is being worked on right now. */
export function setImmediateGoal(subGoalId: string, action: string): void {
  store.immediateGoal = {
    subGoalId,
    action,
    declaredAt: Date.now(),
  }
  // Don't emit — too frequent, every turn. Callers can emit if needed.
}

/** Clear the immediate goal pointer. Called when the agent finishes
 *  a step and moves to the next. */
export function clearImmediateGoal(): void {
  store.immediateGoal = null
}

// ============================================================================
// DAG mutations — delegate to GoalDagEngine
// ============================================================================

/** Add a sub-goal node to the DAG. Delegates to the engine for validation
 *  and topological ordering. */
export function addSubGoal(node: SubGoal): void {
  dagEngine.addNode(node)
  syncMetricsFromEngine()
  emit()
}

/** Remove a sub-goal node from the DAG. */
export function removeSubGoal(nodeId: string): boolean {
  const removed = dagEngine.removeNode(nodeId)
  if (!removed) return false
  syncMetricsFromEngine()
  emit()
  return true
}

/** Update a sub-goal's status. Triggers progress recalculation
 *  and syncs metrics from the engine to keep store/engine in sync. */
export function updateSubGoalStatus(nodeId: string, status: SubGoalStatus): void {
  dagEngine.updateStatus(nodeId, status)
  syncMetricsFromEngine()
  recalculateProgress()
  emit()
}

/** Reorder dependencies for a sub-goal node. */
export function reorderDependency(nodeId: string, newDeps: readonly string[]): void {
  dagEngine.reorderDeps(nodeId, [...newDeps])
  syncMetricsFromEngine()
  emit()
}

/** Merge multiple source sub-goals into a single target. */
export function mergeSubGoals(sourceIds: string[], targetText: string): SubGoal {
  const merged = dagEngine.mergeNodes(sourceIds, targetText)
  syncMetricsFromEngine()
  emit()
  return merged
}

// ============================================================================
// Progress & metrics
// ============================================================================

/** Recalculate overall progress percentage from completed/total ratio. */
export function recalculateProgress(): number {
  if (store.metrics.totalSubGoals === 0) {
    store.progress = 0
  } else {
    const completed = countByStatus('completed')
    store.metrics.completedSubGoals = completed
    store.progress = Math.round((completed / store.metrics.totalSubGoals) * 100)
  }
  return store.progress
}

/** Increment the iteration counter. Called after each evaluation cycle. */
export function incrementIteration(): void {
  store.metrics.iterationCount++
}

/** Record evaluation gap for staleness tracking. Resets on different gap,
 *  accumulates on same gap (triggers circuit breaker at 3). */
export function recordEvalGap(gap: string | null): void {
  const history = store.metrics.evalHistory
  if (gap === history.lastGap && gap !== null) {
    history.consecutiveSameGapCount++
  } else {
    history.lastGap = gap
    history.consecutiveSameGapCount = gap !== null ? 1 : 0
  }
}

// ============================================================================
// Queries — delegate to engine
// ============================================================================

/** Get all sub-goals ready for execution. */
export function getReadySubGoals(): SubGoal[] {
  const readyIds = dagEngine.getReadyNodes()
  return readyIds.map(id => dagEngine.getAllNodes().find(n => n.id === id)).filter(Boolean) as SubGoal[]
}

/** Get all currently active sub-goals. */
export function getActiveSubGoals(): SubGoal[] {
  return dagEngine.getAllNodes().filter(n => n.status === 'active')
}

/** Get all blocked sub-goals. */
export function getBlockedSubGoals(): SubGoal[] {
  return dagEngine.getAllNodes().filter(n => n.status === 'blocked')
}

/** Get all completed sub-goals. */
export function getCompletedSubGoals(): SubGoal[] {
  return dagEngine.getAllNodes().filter(n => n.status === 'completed')
}

/** Get all nodes in the DAG. */
export function getAllNodes(): SubGoal[] {
  return dagEngine.getAllNodes()
}

/** Get the DAG engine instance for direct access. */
export function getDagEngine(): GoalDagEngine {
  return dagEngine
}


// ============================================================================
// Artifacts
// ============================================================================

/** Record a file path as produced during goal execution. */
export function addArtifact(path: string): void {
  if (!store.artifacts.includes(path)) {
    store.artifacts.push(path)
  }
}

// ============================================================================
// Persistence
// ============================================================================

/**
 * Serialize current state to a JSON-safe representation.
 * Uses the engine's Record format (not Map) so it survives JSON.stringify.
 * The in-memory Map is rebuilt on load via rebuildFromEngineNodes().
 */
export function toJSON(): GoalState {
  const engineState = dagEngine.toJSON()
  // Convert engine's Record<string, DagNode> to our store's Map format
  // for the returned GoalState. This is a snapshot, not the live store.
  const nodeMap = new Map<string, SubGoal>()
  for (const [id, node] of Object.entries(engineState.nodes)) {
    nodeMap.set(id, node as SubGoal)
  }
  return {
    ...store,
    dag: {
      nodes: nodeMap,
      edges: [...engineState.edges],
      readyQueue: [],
    },
  }
}

/**
 * Load state from disk, overwriting current in-memory state.
 * Rebuilds both the store and the DAG engine from the persisted data.
 */
/**
 * Load state from disk, overwriting current in-memory state.
 * Rebuilds both the store and the DAG engine from the persisted data,
 * and syncs the version tracker for optimistic concurrency control.
 */
export function load(goalId: GoalId): boolean {
  const loaded = loadGoalState(goalId)
  if (!loaded) return false

  // Reset both store and engine
  store = {
    ...loaded,
    dag: { nodes: new Map(), edges: [], readyQueue: [] },
    artifacts: loaded.artifacts ?? [],
  }
  dagEngine.reset()

  // Rebuild DAG engine from persisted nodes (stored as JSON object)
  // The persistence layer stores dag.nodes as a plain Record, not Map.
  // We reconstruct the engine first, then sync back to the store.
  const persistedNodes = (loaded as any).dag?.nodes
  if (persistedNodes && typeof persistedNodes === 'object' && !(persistedNodes instanceof Map)) {
    for (const [, node] of Object.entries(persistedNodes as Record<string, SubGoal>)) {
      if (node && node.id) {
        dagEngine.addNode(node)
      }
    }
  }

  // Sync version tracker from disk
  currentVersion = readVersion(goalId)

  syncMetricsFromEngine()
  emit()
  return true
}

/**
 * Save current state to disk with version tracking.
 * Returns the new on-disk version number after a successful write.
 *
 * The version number is used for optimistic concurrency control:
 * if another agent modifies the file between our read and write,
 * the next save will detect the conflict via version mismatch.
 */
export function save(): number {
  if (!store.activeGoalId) return 0
  const engineState = dagEngine.toJSON()
  // Convert engine nodes to plain object for JSON compatibility
  const nodesObj: Record<string, SubGoal> = {}
  for (const [id, node] of Object.entries(engineState.nodes)) {
    nodesObj[id] = node as SubGoal
  }
  const newVersion = saveGoalState({
    ...store,
    dag: {
      nodes: nodesObj as unknown as Map<string, SubGoal>,
      edges: [...engineState.edges],
      readyQueue: [],
    },
  })
  currentVersion = newVersion
  return newVersion
}

/** Get the current on-disk version number. Used for conflict detection
 *  in multi-agent scenarios. */
export function getVersion(): number {
  return currentVersion
}

/** Save only if the on-disk version hasn't changed since we last read it.
 *  Returns the new version on success, or -1 on conflict (another writer
 *  modified the file). The caller should retry or merge.
 *
 *  This is an optimistic concurrency control — prevents lost updates
 *  when multiple agents modify the same goal file concurrently. */
export function saveIfNoConflict(): number {
  if (!store.activeGoalId) return -1
  const engineState = dagEngine.toJSON()
  const nodesObj: Record<string, SubGoal> = {}
  for (const [id, node] of Object.entries(engineState.nodes)) {
    nodesObj[id] = node as SubGoal
  }
  const result = saveIfUnchanged(currentVersion, {
    ...store,
    dag: {
      nodes: nodesObj as unknown as Map<string, SubGoal>,
      edges: [...engineState.edges],
      readyQueue: [],
    },
  })
  if (result > 0) currentVersion = result
  return result
}


// ============================================================================
// Lifecycle
// ============================================================================

/** Reset to empty state. */
export function clear(): void {
  store = createEmptyGoalState()
  dagEngine.reset()
  emit()
}

/** Reset and delete persisted file. */
export function clearAndDelete(): void {
  const id = store.activeGoalId
  store = createEmptyGoalState()
  dagEngine.reset()
  if (id) {
    try { deleteGoal(id) } catch { /* file may not exist */ }
  }
  emit()
}

/** Archive current goal and reset. */
export function archive(): void {
  const id = store.activeGoalId
  if (id) {
    try { archiveGoal(id) } catch { /* file may not exist */ }
  }
  clear()
}

// ============================================================================
// Helpers
// ============================================================================

/** Notify subscribers of state change. */
function emit(): void {
  goalChanged.emit(store)
}

/** Sync metrics from DAG engine after mutations.
 *  Rebuilds the store's dag.nodes Map from the engine's node collection.
 *  The engine owns the canonical node list; we mirror it here for the
 *  store's query layer. */
function syncMetricsFromEngine(): void {
  const engineNodes = dagEngine.getAllNodes()
  const nodeMap = new Map<string, SubGoal>()
  for (const node of engineNodes) {
    nodeMap.set(node.id, node)
  }
  store.dag.nodes = nodeMap
  store.dag.edges = [...dagEngine.toJSON().edges]
  store.metrics.totalSubGoals = engineNodes.length
}

/** Count sub-goals by status. */
function countByStatus(status: SubGoalStatus): number {
  let count = 0
  for (const node of dagEngine.getAllNodes()) {
    if (node.status === status) count++
  }
  return count
}
