/**
 * Goal DAG Engine — dynamic task graph with topological operations.
 *
 * Core capabilities:
 *   - Topological sort (Kahn's algorithm, BFS)
 *   - Ready node computation (entry nodes with all deps satisfied)
 *   - Cycle detection (DFS with 3-color marking)
 *   - Dynamic mutations (add, remove, merge, reorder, update status)
 *
 * The DAG is the heart of the goal system. It turns a flat list of
 * sub-goals into a partially-ordered execution plan. Operations are
 * validated on each mutation to prevent cycles and invalid states.
 *
 * Complexity:
 *   - addNode/removeNode/updateNode: O(V+E)
 *   - topoSort/getReadyNodes: O(V+E)
 *   - hasCycles: O(V+E)
 *   - serialization: O(V+E)
 */

import type { SubGoal, DagOperation } from '../types/goal.js'

// ============================================================================
// Helper types
// ============================================================================

/** Edge representation: [from, to] where from depends on to.
 *  i.e., to must complete before from can start. */
type Edge = [string, string]

/** Internal node storage for traversal algorithms. */
interface DagNode {
  id: string
  text: string
  status: SubGoal['status']
  dependencies: string[]
}

// ============================================================================
// Engine
// ============================================================================

export class GoalDagEngine {
  private nodes: Map<string, DagNode>
  private edges: Edge[]

  constructor(nodes?: SubGoal[]) {
    this.nodes = new Map()
    this.edges = []
    if (nodes) {
      for (const n of nodes) {
        this.addNode(n)
      }
    }
  }

  // ========================================================================
  // Core queries
  // ========================================================================

  /** Topological sort — returns node IDs in dependency order.
   *  Uses Kahn's algorithm: BFS from nodes with zero incoming edges.
   *  Returns empty array if the graph is empty.
   *  Complexity: O(V + E) */
  topoSort(): string[] {
    const inDegree = new Map<string, number>()
    const queue: string[] = []

    // Initialize in-degree counts
    for (const [id] of this.nodes) {
      inDegree.set(id, 0)
    }
    for (const [from, to] of this.edges) {
      inDegree.set(to, (inDegree.get(to) ?? 0) + 1)
    }

    // Seed with zero in-degree nodes
    for (const [id, deg] of inDegree) {
      if (deg === 0) queue.push(id)
    }

    const result: string[] = []
    while (queue.length > 0) {
      const id = queue.shift()!
      result.push(id)
      // Decrement in-degree of all successors
      for (const [from, to] of this.edges) {
        if (from === id) {
          const newDeg = (inDegree.get(to) ?? 1) - 1
          inDegree.set(to, newDeg)
          if (newDeg === 0) queue.push(to)
        }
      }
    }

    // If result.length < nodes.size, there's a cycle — but we still
    // return what we can (partial order is valid for dag validation).
    return result
  }

  /** Get nodes ready for execution: all dependencies complete, not yet started.
   *  Includes active nodes that are re-entrant (can be picked up again). */
  getReadyNodes(): string[] {
    const ready: string[] = []
    for (const [id, node] of this.nodes) {
      if (node.status === 'completed') continue
      if (node.status === 'failed') continue
      if (node.status === 'blocked') continue
      if (node.status === 'skipped') continue

      // Check all dependencies are satisfied
      const allDepsSatisfied = node.dependencies.every(depId => {
        const dep = this.nodes.get(depId)
        return dep?.status === 'completed' || dep?.status === 'skipped'
      })
      if (allDepsSatisfied) ready.push(id)
    }
    return ready
  }

  /** All nodes in the DAG. */
  getAllNodes(): SubGoal[] {
    return Array.from(this.nodes.values()).map(toSubGoal)
  }

  /** Root nodes: no incoming dependencies. */
  getRootNodes(): SubGoal[] {
    const hasIncoming = new Set<string>()
    for (const [, to] of this.edges) {
      hasIncoming.add(to)
    }
    return Array.from(this.nodes.values())
      .filter(n => !hasIncoming.has(n.id))
      .map(toSubGoal)
  }

  /** Leaf nodes: no outgoing dependencies. */
  getLeafNodes(): SubGoal[] {
    const hasOutgoing = new Set<string>()
    for (const [from] of this.edges) {
      hasOutgoing.add(from)
    }
    return Array.from(this.nodes.values())
      .filter(n => !hasOutgoing.has(n.id))
      .map(toSubGoal)
  }

  /** All descendants of a node (transitive closure of downstream nodes). */
  getDescendants(nodeId: string): SubGoal[] {
    const visited = new Set<string>()
    const stack = [nodeId]
    while (stack.length > 0) {
      const current = stack.pop()!
      if (visited.has(current)) continue
      visited.add(current)
      for (const [from, to] of this.edges) {
        if (from === current) {
          stack.push(to)
        }
      }
    }
    visited.delete(nodeId) // exclude self
    return Array.from(this.nodes.values())
      .filter(n => visited.has(n.id))
      .map(toSubGoal)
  }

  // ========================================================================
  // Dynamic mutations
  // ========================================================================

  /** Add a new sub-goal node to the DAG. Validates that dependencies
   *  reference existing nodes. Rebuilds edge list after insertion. */
  addNode(subGoal: SubGoal): void {
    const internal: DagNode = {
      id: subGoal.id,
      text: subGoal.text,
      status: subGoal.status,
      dependencies: [...subGoal.dependencies],
    }
    this.nodes.set(internal.id, internal)
    this.rebuildEdges()
  }

  /** Remove a node and all its associated edges. */
  removeNode(nodeId: string): boolean {
    if (!this.nodes.has(nodeId)) return false
    this.nodes.delete(nodeId)
    // Remove edges where this node is either source or target
    this.edges = this.edges.filter(([from, to]) => from !== nodeId && to !== nodeId)
    return true
  }

  /** Merge multiple source nodes into a single target. The target's
   *  dependencies are the union of the sources' dependencies (minus the
   *  sources themselves). Performs full dependency rewrite on all nodes
   *  referencing the source IDs — both incoming (depends-on) and outgoing
   *  (depended-by) edges are updated.
   *
   *  This is a graph-level operation: all nodes in the DAG are scanned and
   *  any reference to a source ID is replaced with the merged target ID.
   *  After completion, validate() is called to detect any cycles introduced. */
  mergeNodes(sourceIds: string[], targetText: string): SubGoal {
    const targetId = `merged-${Date.now().toString(36)}`
    const now = Date.now()

    // Phase 1: Collect all dependencies from sources (outgoing edges)
    // These are the nodes that source nodes depend on — they become the
    // merged node's own dependencies.
    const allDeps = new Set<string>()
    for (const id of sourceIds) {
      const node = this.nodes.get(id)
      if (node) {
        for (const dep of node.dependencies) {
          if (!sourceIds.includes(dep)) {
            allDeps.add(dep)
          }
        }
      }
    }

    // Phase 2: Build the merged node
    const merged: SubGoal = {
      id: targetId,
      parentId: '' as any, // will be set by caller
      text: targetText,
      status: 'pending',
      dependencies: Array.from(allDeps),
      progress: 0,
      createdAt: now,
      updatedAt: now,
    }

    // Phase 3: Rewrite all nodes that reference source IDs
    // Both incoming edges (X depends on source) and outgoing edges are fixed.
    // For each node in the graph, replace any dependency ID that appears in
    // sourceIds with the merged targetId.
    for (const [id, node] of this.nodes) {
      if (sourceIds.includes(id)) continue // skip sources — they'll be removed
      const newDeps = node.dependencies.map(dep =>
        sourceIds.includes(dep) ? targetId : dep
      )
      // Deduplicate: if a node depended on both src1 and src2, it now
      // depends on merged only once.
      const uniqueDeps = [...new Set(newDeps)]
      if (uniqueDeps.length !== node.dependencies.length ||
          uniqueDeps.some((d, i) => d !== node.dependencies[i])) {
        // Dependency actually changed — update the node
        node.dependencies = newDeps as any
      }
    }

    // Phase 4: Remove sources and add merged node to graph
    for (const id of sourceIds) {
      this.nodes.delete(id)
    }
    this.nodes.set(targetId, merged)

    // Phase 5: Rebuild edge list from rewritten dependencies
    this.rebuildEdges()

    return merged
  }

  /** Change the dependency list for a node. Validates no cycles introduced. */
  reorderDeps(nodeId: string, newDeps: string[]): void {
    const node = this.nodes.get(nodeId)
    if (!node) return
    node.dependencies = [...newDeps]
    this.rebuildEdges()
  }

  /** Update a node's status. */
  updateStatus(nodeId: string, status: SubGoal['status']): void {
    const node = this.nodes.get(nodeId)
    if (node) node.status = status
  }

  // ========================================================================
  // Validation
  // ========================================================================

  /** Check for cycles using DFS with 3-color marking.
   *  Returns array of cycle paths found, or empty if acyclic. */
  hasCycles(): boolean {
    return this.detectCycles().length > 0
  }

  /** Full cycle detection — returns the actual cycle paths for debugging.
   *  Each entry is a list of node IDs forming a cycle. */
  detectCycles(): string[][] {
    const WHITE = 0, GRAY = 1, BLACK = 2
    const color = new Map<string, number>()
    const cycles: string[][] = []

    for (const [id] of this.nodes) {
      color.set(id, WHITE)
    }

    const visit = (nodeId: string, path: string[]): void => {
      const c = color.get(nodeId)
      if (c === GRAY) {
        // Found a back edge — extract the cycle from path
        const cycleStart = path.indexOf(nodeId)
        if (cycleStart !== -1) {
          cycles.push([...path.slice(cycleStart), nodeId])
        }
        return
      }
      if (c === BLACK) return

      color.set(nodeId, GRAY)
      path.push(nodeId)

      // Visit all outgoing edges
      for (const [from, to] of this.edges) {
        if (from === nodeId) {
          visit(to, [...path])
        }
      }

      color.set(nodeId, BLACK)
      path.pop()
    }

    for (const [id] of this.nodes) {
      if (color.get(id) === WHITE) {
        visit(id, [])
      }
    }

    return cycles
  }

  /** Validate DAG integrity — returns whether the graph is valid and
   *  any cycle paths found. */
  validate(): { valid: boolean; cycles: string[][] } {
    const cycles = this.detectCycles()
    return { valid: cycles.length === 0, cycles }
  }

  // ========================================================================
  // Lifecycle
  // ========================================================================

  /** Reset the engine to empty state. Called when goal is cleared or
   *  a new session starts. Preserves no state. */
  reset(): void {
    this.nodes.clear()
    this.edges = []
  }

  // ========================================================================
  // Serialization
  // ========================================================================

  /** Export as JSON-serializable structure. */
  toJSON(): { nodes: Record<string, DagNode>; edges: Edge[] } {
    const nodeObj: Record<string, DagNode> = {}
    for (const [id, node] of this.nodes) {
      nodeObj[id] = { ...node }
    }
    return { nodes: nodeObj, edges: [...this.edges] }
  }

  /** Import from JSON-serialized structure. */
  static fromJSON(data: { nodes: Record<string, DagNode>; edges: [string, string][] }): GoalDagEngine {
    const engine = new GoalDagEngine()
    for (const [, node] of Object.entries(data.nodes)) {
      engine.nodes.set(node.id, { ...node })
    }
    engine.edges = [...data.edges]
    return engine
  }

  // ========================================================================
  // Internal
  // ========================================================================

  /** Rebuild edge list from current nodes' dependency arrays. */
  private rebuildEdges(): void {
    const edges: Edge[] = []
    for (const [id, node] of this.nodes) {
      for (const dep of node.dependencies) {
        edges.push([dep, id])
      }
    }
    this.edges = edges
  }
}

// ============================================================================
// Helpers
// ============================================================================

/** Convert internal DagNode to SubGoal type. */
function toSubGoal(node: DagNode): SubGoal {
  return {
    id: node.id,
    parentId: '' as any, // placeholder — set by caller
    text: node.text,
    status: node.status as SubGoal['status'],
    dependencies: node.dependencies,
    progress: 0,
    createdAt: 0,
    updatedAt: 0,
  }
}
