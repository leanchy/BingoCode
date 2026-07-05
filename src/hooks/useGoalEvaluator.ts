/**
 * Goal evaluator hook — post-turn goal assessment.
 *
 * Fires after each turn completes (triggered by lastQueryCompletionTime change).
 * Evaluates progress toward active goal using env-aware evaluator v2.
 *
 * Migrated from old state.ts flat fields to the new GoalStore API.
 * All state access goes through GoalStore — no more STATE.goalCondition fallbacks.
 */

import { useEffect, useRef } from 'react'
import type { MutableRefObject } from 'react'
import type { MessageType } from '../components/messages.js'
import {
  getGoalState,
  recalculateProgress,
  incrementIteration,
  recordEvalGap,
  getActiveGoalId,
  getReadySubGoals,
  getBlockedSubGoals,
} from '../utils/goalStore.js'
import { enqueue } from '../utils/messageQueueManager.js'
import { evaluateGoal } from '../utils/goalEvaluator.js'

type UseGoalEvaluatorParams = {
  lastQueryCompletionTime: number
  messagesRef: MutableRefObject<MessageType[]>
  isQueryActive: boolean
}

/**
 * React hook — fires after each turn. Triggered by lastQueryCompletionTime.
 * Uses messagesRef (sync ref, not React state) to avoid batching issues.
 *
 * Flow:
 *   1. Check max iterations reached → if so, stop
 *   2. Call env-aware evaluator v2 (rule engine + Haiku + main model)
 *   3. On satisfied → clear goal, enqueue success message
 *   4. On repeated gap (3x) → circuit breaker, clear goal
 *   5. On not satisfied → enqueue continuation message
 */
export function useGoalEvaluator({
  lastQueryCompletionTime,
  messagesRef,
  isQueryActive,
}: UseGoalEvaluatorParams): void {
  const lastEvaluatedAt = useRef(0)
  const evaluating = useRef(false)

  useEffect(() => {
    const goalState = getGoalState()
    const condition = goalState.userGoal?.text ?? null
    if (!condition) return
    if (isQueryActive) return
    if (lastQueryCompletionTime === 0) return
    if (lastQueryCompletionTime === lastEvaluatedAt.current) return
    if (evaluating.current) return

    lastEvaluatedAt.current = lastQueryCompletionTime
    evaluating.current = true

    void (async () => {
      try {
        const iterCount = goalState.metrics.iterationCount
        const maxIter = goalState.metrics.maxIterations

        // Max iterations check — circuit breaker
        if (iterCount >= maxIter) {
          // Clear goal from store (delegates to clear() which resets engine too)
          const { clear } = require('../utils/goalStore.js')
          clear()
          enqueue({
            value: `Goal not achieved after ${maxIter} iterations. Goal was: "${condition}"`,
            mode: 'task-notification',
            priority: 'now',
          })
          return
        }

        // Get messages + current sub-goal for evaluation context
        const messages = messagesRef.current
        const currentSubGoal = goalState.immediateGoal
          ? goalState.dag.nodes.get(goalState.immediateGoal.subGoalId)
          : undefined

        // Run environment-aware evaluation (rule engine + semantic + final)
        const result = await evaluateGoal(condition, messages, currentSubGoal)

        // Race: user may have cleared goal during async evaluation
        if (!getActiveGoalId()) return

        incrementIteration()
        recordEvalGap(result.gap)
        recalculateProgress()

        // Check active sub-goals and blocked count for drift diagnosis
        const ready = getReadySubGoals()
        const blocked = getBlockedSubGoals()
        if (blocked.length > 0 && ready.length === 0) {
          // All sub-goals blocked — need to replan or escalate
          void ready
          void blocked
        }

        // Circuit breaker: 3 consecutive same gap
        const evalHistory = goalState.metrics.evalHistory
        const isRepeatedGap = evalHistory.consecutiveSameGapCount >= 3 && result.gap !== null

        if (result.satisfied) {
          // Goal achieved — clear from store and file system
          const { clearAndDelete } = require('../utils/goalStore.js')
          clearAndDelete()
          enqueue({
            value: `Goal achieved (iteration ${iterCount + 1}): ${result.reason}`,
            mode: 'task-notification',
            priority: 'now',
          })
        } else if (isRepeatedGap) {
          // Circuit breaker — same gap repeated 3 times, stop looping
          const { clear } = require('../utils/goalStore.js')
          clear()
          enqueue({
            value: `Goal evaluator stopped — same gap "${result.gap}" ${evalHistory.consecutiveSameGapCount}x. Adjust approach or output EVAL blocks.`,
            mode: 'task-notification',
            priority: 'now',
          })
        } else {
          // Not yet satisfied — continue
          const continueMsg = result.gap
            ? `Goal not yet met (${iterCount + 1}/${maxIter}). Gap: ${result.gap}. Continue toward: "${condition}"`
            : `Goal not yet met (${iterCount + 1}/${maxIter}, reason: ${result.reason}). Continue toward: "${condition}"`
          enqueue({
            value: continueMsg,
            mode: 'task-notification',
            priority: 'now',
          })
        }
      } catch (err) {
        // Evaluation error is non-fatal — log and continue
        console.error('[GoalEvaluator] Evaluation error:', err)
      } finally {
        evaluating.current = false
      }
    })()
  }, [lastQueryCompletionTime, isQueryActive]) // messagesRef is stable ref — not included as dep
}
