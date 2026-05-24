import {
  getGoalCondition,
  getGoalMaxIterations,
  setGoalCondition,
} from '../../bootstrap/state.js'
import { registerBundledSkill } from '../bundledSkills.js'

const USAGE = `Usage: /goal <condition>

Set a session goal. The agent will keep working until the condition is met.

Examples:
  /goal all tests pass
  /goal login flow handles empty email without crash
  /goal PR is ready for review with passing CI

To cancel: /goal clear`

export function registerGoalSkill(): void {
  registerBundledSkill({
    name: 'goal',
    description:
      'Set a session-level goal condition and loop until met. Use when user says "/goal <condition>" or wants autonomous execution until a specific outcome is reached.',
    argumentHint: '<condition | clear>',
    userInvocable: true,
    async getPromptForCommand(args) {
      const trimmed = args.trim()

      if (!trimmed) {
        return [{ type: 'text', text: USAGE }]
      }

      if (['clear', 'stop', 'cancel'].includes(trimmed)) {
        const current = getGoalCondition()
        if (current) {
          setGoalCondition(null)
          return [
            {
              type: 'text',
              text: `Goal cancelled: "${current}". Tell the user their goal has been cancelled.`,
            },
          ]
        }
        return [
          {
            type: 'text',
            text: 'No active goal to cancel. Tell the user there is no active goal.',
          },
        ]
      }

      setGoalCondition(trimmed)
      const maxIter = getGoalMaxIterations()

      return [
        {
          type: 'text',
          text: `# /goal activated

Goal condition: "${trimmed}"

This goal is now registered for this session. An independent evaluator model will check after each turn whether the goal is satisfied. Maximum ${maxIter} iterations.

Tell the user: Goal set — you will work autonomously until "${trimmed}" is achieved (max ${maxIter} turns). Send \`/goal clear\` to cancel.

Now begin: assess current state and take the first concrete action toward the goal.`,
        },
      ]
    },
  })
}
