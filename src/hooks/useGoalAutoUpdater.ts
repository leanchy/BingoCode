/**
 * Goal Auto-Updater Hook — bridges agent tool execution with goal state.
 *
 * Monitors PostToolUse events and automatically updates goal state in real-time.
 * This replaces the manual "output EVAL blocks" approach with automatic state
 * tracking based on what the agent actually does.
 *
 * Integration point: called in REPL.tsx after each tool execution completes.
 * Uses the GoalStore to update state, which triggers re-renders in any
 * subscribed components via the signal pattern.
 */

import type { ToolResult, SubGoalStatus } from '../types/goal.js'
import { getGoalState, addArtifact, updateSubGoalStatus, recalculateProgress } from '../utils/goalStore.js'
import { asSubGoalId } from '../utils/goalHelpers.js'
import { assessDrift } from '../utils/goalDrift.js'
import type { DriftAssessment, SubGoal } from '../types/goal.js'

/**
 * Classify a tool execution result into a goal-relevant action category.
 * Returns null if the tool is not relevant to goal progress tracking.
 */
function classifyToolAction(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolOutput: string,
  success: boolean,
): ToolAction | null {
  // Read-only tools (query) → informational, not state-changing
  if (isReadTool(toolName)) return null

  // Write tools (create/modify)
  if (isCreateTool(toolName)) {
    const filePath = extractFilePath(toolInput)
    return {
      type: 'create',
      filePath,
      subGoalId: inferSubGoal(toolName, filePath),
      description: `Created ${filePath}`,
    }
  }

  // Build tools (verify)
  if (isVerifyTool(toolName)) {
    return {
      type: 'verify',
      filePath: extractFilePath(toolInput),
      subGoalId: inferSubGoal(toolName, extractFilePath(toolInput)),
      description: `Verified with ${toolName}`,
    }
  }

  // Default: generic mutation
  return {
    type: 'modify',
    filePath: extractFilePath(toolInput),
    subGoalId: inferSubGoal(toolName, extractFilePath(toolInput)),
    description: `Modified via ${toolName}`,
  }
}

type ToolAction = {
  type: 'create' | 'modify' | 'verify'
  filePath: string
  subGoalId: string
  description: string
}

/** Update goal state after a tool execution. Called from REPL.tsx after
 *  each PostToolUse event. Also performs drift assessment to detect
 *  when agent behavior starts deviating from target goals. */
export function useGoalAutoUpdater(
  toolResult: ToolResult,
): void {
  const state = getGoalState()
  if (!state.activeGoalId) return
  if (!state.operationalGoal) return

  const action = classifyToolAction(
    toolResult.toolName,
    toolResult.toolInput,
    toolResult.toolOutput,
    toolResult.success,
  )

  if (!action) return

  // Phase 1: Update goal state based on action type
  switch (action.type) {
    case 'create':
      addArtifact(action.filePath)
      break
    case 'modify':
      addArtifact(action.filePath)
      break
    case 'verify':
      updateSubGoalStatus(action.subGoalId, 'active')
      break
  }

  // Phase 2: Recalculate progress after state mutation
  recalculateProgress()

  // Phase 3: Assess drift (after state update, before next turn)
  const currentSubGoal = state.dag.nodes.get(action.subGoalId)
  if (currentSubGoal) {
    const drift = assessDrift(
      action.description ?? `${toolResult.toolName}: ${toolResult.toolOutput.slice(0, 100)}`,
      currentSubGoal,
      state.operationalGoal.text,
    )

    // Log drift warnings for debugging — future: escalate to enqueue()
    if (drift.warnings.length > 0) {
      const highWarnings = drift.warnings.filter(w => w.severity === 'high')
      if (highWarnings.length > 0) {
        // Drift is severe — agent should replan
        // TODO: wire into enqueue() for user-visible warning
        console.warn(`[GoalDrift] ${drift.warnings.length} warning(s): score ${drift.consistencyScore}%, trend ${drift.trend}`)
      }
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

/** Check if a tool is read-only (doesn't modify state). */
function isReadTool(toolName: string): boolean {
  const readTools = new Set([
    'Read',
    'Glob',
    'Grep',
    'LS',
    'WebSearch',
    'WebFetch',
    'TaskOutput',
    'TaskStatus',
  ])
  return readTools.has(toolName)
}

/** Check if a tool creates new files. */
function isCreateTool(toolName: string): boolean {
  const createTools = new Set([
    'Write',
    'Edit',    // can create or modify, but classified as create for new files
    'NotebookEdit',
  ])
  return createTools.has(toolName)
}

/** Check if a tool verifies existing work (tests, builds). */
function isVerifyTool(toolName: string): boolean {
  const verifyTools = new Set([
    'Bash',     // often used for test/build commands
  ])
  return verifyTools.has(toolName)
}

/** Extract file path from tool input. Handles different tool input shapes. */
function extractFilePath(input: Record<string, unknown>): string {
  if (typeof input.file_path === 'string') return input.file_path
  if (typeof input.path === 'string') return input.path
  if (typeof input.notebook_path === 'string') return input.notebook_path
  return ''
}

/** Infer which sub-goal this tool action likely belongs to.
 *  Uses file path heuristics to match against known sub-goals. */
function inferSubGoal(toolName: string, filePath: string): string {
  // For now, use a simple heuristic — match by file path pattern
  // This will be enhanced in Phase 6 with actual DAG integration
  if (!filePath) return 'unknown'

  // Strip the path and use the filename as a sub-goal identifier
  // In practice, the real mapping will come from the DAG's SubGoal nodes
  const fileName = filePath.split('/').pop()?.split('\\').pop() ?? filePath
  return `task-${fileName}`
}

// ============================================================================
// Re-export for convenience
// ============================================================================

export { getGoalState as useGoalStore }
