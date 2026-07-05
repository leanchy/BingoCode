/**
 * Goal command — CLI entry point for Goal Management system.
 *
 * 4-layer architecture: User Goal → Operational Goal → Sub Goals → Immediate Goal.
 * Orchestrates creation, status queries, and management commands.
 */

import { getGoalState, setUserGoal, setOperationalGoal, clearState } from '../../utils/goalStore.js'
import { registerBundledSkill } from '../bundledSkills.js'

const USAGE = `Usage: /goal <create | clear | cancel>

Set a session goal. Agent will work autonomously until goal met.

Examples:
  /goal create all tests pass
  /goal create login flow handles empty email without crash
  /goal create PR ready for review with passing CI

To cancel: /goal clear or /goal cancel`

export function registerGoalSkill(): void {
  registerBundledSkill({
    name: 'goal',
    description:
      'Manage task goals with hierarchical decomposition and progress tracking.',
    argumentHint: '<create | clear | cancel>',
    userInvocable: true,
    async getPromptForCommand(args) {
      const trimmed = args.trim()

      if (!trimmed) {
        return [{ type: 'text', text: USAGE }]
      }

      // --- Cancel / Clear ---
      if (['clear', 'stop', 'cancel'].includes(trimmed.toLowerCase())) {
        const state = getGoalState()
        if (state.activeGoalId) {
          const userText = state.userGoal?.text ?? '(unknown)'
          clearState()
          return [
            {
              type: 'text',
              text: `Goal cancelled: "${userText}". Goal state cleared from memory and disk.`,
            },
          ]
        }
        return [
          {
            type: 'text',
            text: 'No active goal. Use `/goal create <text>` to start.',
          },
        ]
      }

      // --- Create ---
      setUserGoal(trimmed)
      setOperationalGoal(trimmed)
      const state = getGoalState()
      const maxIter = state.metrics.maxIterations

      return [
        {
          type: 'text',
          text: `# /goal activated

**Goal**: "${trimmed}"
**Architecture**: User Goal → Operational Goal → DAG Sub Goals → Immediate Action
**Max iterations**: ${maxIter}

The evaluator now uses **environment-aware assessment** (3 tiers):
  Level 1: Rule engine — checks file existence, test output, compile status
  Level 2: Haiku 4.5 — semantic interpretation of evidence
  Level 3: Main model — final verification (ambiguous cases only)

EVAL blocks still welcome for agent self-reporting, but no longer required.
  Format: \`EVAL: metric: value / target → ✓ or ✗\`

Tell user: Goal set. Agent works autonomously until "${trimmed}" achieved (max ${maxIter} turns).
Send \`/goal clear\` to cancel.

Now: assess current state, take first concrete action toward goal.`,
        },
      ]
    },
  })
}
