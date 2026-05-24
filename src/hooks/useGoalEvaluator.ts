import { useEffect, useRef } from 'react'
import type { MutableRefObject } from 'react'
import type { MessageType } from '../components/messages.js'
import {
  getGoalCondition,
  getGoalIterationCount,
  getGoalMaxIterations,
  incrementGoalIterationCount,
  setGoalCondition,
} from '../bootstrap/state.js'
import { enqueue } from '../utils/messageQueueManager.js'
import { evaluateGoal } from '../utils/goalEvaluator.js'

type UseGoalEvaluatorParams = {
  lastQueryCompletionTime: number
  messagesRef: MutableRefObject<MessageType[]>
  isQueryActive: boolean
}

/**
 * React hook that fires an independent goal evaluator after each turn.
 *
 * Triggered by lastQueryCompletionTime changing (set in REPL.tsx after
 * queryGuard.end() succeeds). Uses messagesRef (not React state) to avoid
 * batching issues — the ref is synchronously updated via Zustand pattern
 * before React re-renders.
 *
 * On goal not satisfied: enqueues a continuation message with priority 'now'
 * so useQueueProcessor picks it up immediately for the next turn.
 * On goal satisfied or max iterations reached: clears the goal condition.
 */
export function useGoalEvaluator({
  lastQueryCompletionTime,
  messagesRef,
  isQueryActive,
}: UseGoalEvaluatorParams): void {
  const lastEvaluatedAt = useRef(0)
  const evaluating = useRef(false)

  useEffect(() => {
    const condition = getGoalCondition()
    if (!condition) return
    if (isQueryActive) return
    if (lastQueryCompletionTime === 0) return
    if (lastQueryCompletionTime === lastEvaluatedAt.current) return
    if (evaluating.current) return

    lastEvaluatedAt.current = lastQueryCompletionTime
    evaluating.current = true

    void (async () => {
      try {
        const iterCount = getGoalIterationCount()
        const maxIter = getGoalMaxIterations()

        if (iterCount >= maxIter) {
          setGoalCondition(null)
          enqueue({
            value: `⚠️ /goal stopped after ${maxIter} iterations. Goal not achieved: "${condition}"`,
            mode: 'task-notification',
            priority: 'now',
          })
          return
        }

        // Read snapshot BEFORE await to avoid stale data
        const messages = messagesRef.current
        const result = await evaluateGoal(condition, messages)

        // Race protection: user may have called /goal clear during the await
        if (getGoalCondition() !== condition) return

        incrementGoalIterationCount()

        if (result.satisfied) {
          setGoalCondition(null)
          enqueue({
            value: `✅ Goal achieved (iteration ${iterCount + 1}): ${result.reason}`,
            mode: 'task-notification',
            priority: 'now',
          })
        } else {
          const continueMsg = result.gap
            ? `Goal not yet met (${iterCount + 1}/${maxIter}). Gap: ${result.gap}. Continue toward: "${condition}"`
            : `Goal not yet met (${iterCount + 1}/${maxIter}, reason: ${result.reason}). Continue toward: "${condition}"`
          enqueue({
            value: continueMsg,
            mode: 'task-notification',
            priority: 'now',
          })
        }
      } finally {
        evaluating.current = false
      }
    })()
    // messages intentionally excluded from deps — read via ref to avoid batching issues
  }, [lastQueryCompletionTime, isQueryActive])
}
