/**
 * Goal system helper utilities — shared between hooks and store.
 *
 * Provides:
 *   - asSubGoalId: convert a string to a proper SubGoal identifier
 *   - classifyToolAction: map tool execution to goal-relevant action
 */

import type { SubGoal, SubGoalStatus } from '../types/goal.js'

/** Convert a DAG node ID to a proper SubGoal identifier. */
export function asSubGoalId(id: string): SubGoal['id'] {
  return id as SubGoal['id']
}

/** Create a SubGoal from the goal store. Used by hooks to build
 *  SubGoal objects for DAG operations. */
export function createSubGoal(
  id: string,
  text: string,
  dependencies: string[] = [],
  parentId: string = '',
): SubGoal {
  return {
    id,
    parentId: parentId as any,
    text,
    status: 'pending',
    dependencies,
    progress: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

/** Helper to add a new sub-goal to the DAG. */
export function addSubGoalToDag(
  store: { dag: { nodes: Map<string, SubGoal> } },
  text: string,
  deps: string[] = [],
): SubGoal {
  const id = generateSubGoalId()
  const subGoal = createSubGoal(id, text, deps)
  return subGoal
}

let counter = 0
function generateSubGoalId(): string {
  return `sg-${++counter}-${Date.now().toString(36)}`
}

/** Get a sub-goal from the DAG by ID. Returns null if not found. */
export function getSubGoal(store: { dag: { nodes: Map<string, SubGoal> } }, id: string): SubGoal | null {
  return store.dag.nodes.get(id) ?? null
}

/** Update a sub-goal's status in the DAG. */
export function updateSubGoal(
  store: { dag: { nodes: Map<string, SubGoal> } },
  id: string,
  status: SubGoalStatus,
): void {
  const node = store.dag.nodes.get(id)
  if (node) {
    node.status = status
    node.updatedAt = Date.now()
  }
}

/** Check if all dependencies are satisfied for a sub-goal. */
export function canStartSubGoal(
  store: { dag: { nodes: Map<string, SubGoal> } },
  id: string,
): boolean {
  const node = store.dag.nodes.get(id)
  if (!node) return false
  return node.dependencies.every(depId => {
    const dep = store.dag.nodes.get(depId)
    return dep?.status === 'completed' || dep?.status === 'skipped'
  })
}

// ============================================================================
// SDK adapter — converts SDK tool result format to goal system types
// ============================================================================

/**
 * Convert Anthropic SDK tool execution results to the goal system's
 * internal ToolResult format. Used at the PostToolUse hook point in
 * query.ts to bridge between the SDK's message format and goal types.
 *
 * This avoids importing SDK types directly in hooks (keeps the boundary
 * clean) while providing a single conversion point for the goal system.
 */
export function convertSDKToolResults(
  toolUseBlocks: ReadonlyArray<{ id: string; name: string; input: Record<string, unknown> }>,
  toolResults: ReadonlyArray<{ type: string; message: { content: { type: string; text?: string; tool_use_id?: string; content?: string }[] } }>,
): { toolName: string; toolInput: Record<string, unknown>; toolOutput: string; success: boolean; timestamp: number }[] {
  const results: { toolName: string; toolInput: Record<string, unknown>; toolOutput: string; success: boolean; timestamp: number }[] = []
  let unmatchedCount = 0

  for (const block of toolUseBlocks) {
    // Find matching result for this tool use block
    const matched = toolResults.find(
      result =>
        result.type === 'user' &&
        Array.isArray(result.message.content) &&
        result.message.content.some(
          content =>
            content.type === 'tool_result' &&
            content.tool_use_id === block.id,
        ),
    )

    let output = ''
    let success = true
    if (matched) {
      const resultBlock = matched.message.content.find(
        content => content.type === 'tool_result' && content.tool_use_id === block.id,
      )
      if (resultBlock) {
        output = typeof resultBlock.content === 'string'
          ? resultBlock.content
          : JSON.stringify(resultBlock.content ?? '')
        success = !(resultBlock as any).is_error
      }
    } else {
      unmatchedCount++
      success = false
      output = '(no result found)'
    }

    results.push({
      toolName: block.name,
      toolInput: block.input as Record<string, unknown>,
      toolOutput: output,
      success,
      timestamp: Date.now(),
    })
  }

  // Warn on unmapped results — may indicate SDK protocol change or
  // tool results arriving outside the expected message order.
  // One-off mismatches are normal (e.g., parallel tool calls), but
  // consistent failures across all tools indicate a real problem.
  if (unmatchedCount > 0) {
    console.warn(
      `[GoalAdapter] ${unmatchedCount}/${toolUseBlocks.length} tool result(s) unmatched. ` +
      `Tool result count: ${toolResults.length}, tool use blocks: ${toolUseBlocks.length}. ` +
      `If all results are missing, check SDK message format compatibility.`,
    )
  }

  return results
}
