import Anthropic from '@anthropic-ai/sdk'
import type { MessageType } from '../components/messages.js'

export const GOAL_EVALUATOR_MODEL = 'claude-haiku-4-5'

export type GoalEvalResult = {
  satisfied: boolean
  reason: string
  gap: string | null
}

/**
 * Evaluate whether the goal condition has been met based on recent messages.
 *
 * Runs as an independent Anthropic client call — completely decoupled from the
 * main query chain. Never pollutes conversation state or tool history.
 */
export async function evaluateGoal(
  goalCondition: string,
  messages: MessageType[],
): Promise<GoalEvalResult> {
  const client = new Anthropic({
    baseURL: process.env.ANTHROPIC_BASE_URL ?? undefined,
    apiKey: process.env.ANTHROPIC_API_KEY ?? 'dummy',
  })

  const recentAssistantTexts = messages
    .filter(m => m.type === 'assistant' || m.role === 'assistant')
    .slice(-5)
    .map(m => {
      if (typeof m.message?.content === 'string') return m.message.content
      if (Array.isArray(m.message?.content)) {
        return m.message.content
          .filter((b: { type: string }) => b.type === 'text')
          .map((b: { text: string }) => b.text)
          .join('\n')
      }
      return ''
    })
    .filter(Boolean)
    .join('\n---\n')

  const prompt = `You are a goal completion evaluator. Determine if the goal has been fully achieved.

Goal: "${goalCondition}"

Recent assistant output:
${recentAssistantTexts || '(none yet)'}

Respond in JSON only:
{"satisfied": true|false, "reason": "<one sentence>", "gap": "<missing item or null>"}`

  const response = await client.messages.create({
    model: GOAL_EVALUATOR_MODEL,
    max_tokens: 256,
    messages: [{ role: 'user', content: prompt }],
  })

  const text =
    response.content[0]?.type === 'text' ? response.content[0].text : ''
  try {
    const cleaned = text.replace(/^```(?:json)?\n?|\n?```$/g, '').trim()
    return JSON.parse(cleaned) as GoalEvalResult
  } catch {
    return { satisfied: false, reason: 'Evaluator parse error', gap: text }
  }
}
