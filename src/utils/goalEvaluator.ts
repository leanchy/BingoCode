import Anthropic from '@anthropic-ai/sdk'
import type { MessageType } from '../components/messages.js'

export const GOAL_EVALUATOR_MODEL = 'claude-haiku-4-5'

export type GoalEvalResult = {
  satisfied: boolean
  reason: string
  gap: string | null
}

// --- EVAL Block parser for structured evaluation ---

type EvalBlock = {
  metric: string
  valueTarget: string
  passed: boolean
}

/**
 * Parse markdown text for structured > EVAL: lines.
 *
 * Accepted actor formats:
 *   > EVAL: <metric>: <value> / <target> → ✓ or ✗
 *   > EVAL: <metric>: <value> / <target> -> PASS
 *   > EVAL: <metric>: <value> / <target> => true
 *
 * Supports ASCII and Unicode arrow/check/cross variants for maximum compatibility.
 */
function parseEvalBlocks(text: string): EvalBlock[] {
  const blocks: EvalBlock[] = []

  // Build one combined pattern: capture metric + valuetarget + pass/fail signal.
  // Arrow variants: → (U+2192), -> (ASCII), => (ASCII)
  // Pass variants: ✓ (U+2713), ✔ (U+2714), PASS (case-insensitive), Y, true, yes, 1
  // Fail variants: ✗ (U+2717), ✘ (U+2718), FAIL (case-insensitive), N, false, no, 0
  // NOTE: Removed the requirement for ">" prefix to allow EVAL blocks anywhere in text
  const arrow = /(?:→|->|=>)/g.source
  const pass = /(?:✓|✔|PASS|pass|Y\b|true|yes|1)/g.source
  const fail = /(?:✗|✘|FAIL|fail|N\b|false|no|0)/g.source
  const full = new RegExp(
    `EVAL:\\s*(.+?):\\s*(.+?)\\s*(?:${arrow}|)\\s*(${pass}|${fail})`,
    'g',
  )

  let match: RegExpExecArray | null
  while ((match = full.exec(text)) !== null) {
    const [, metric, valueTarget, signal] = match
    const passed = /^(✓|✔|PASS|pass|Y\b|true|yes|1)$/.test(signal.trim())
    blocks.push({ metric: metric.trim(), valueTarget: valueTarget.trim(), passed })
  }
  return blocks
}

/** Determine if all metrics pass — enabling early termination. */
function allMetricsPassing(blocks: EvalBlock[]): boolean {
  return blocks.length > 0 && blocks.every(b => b.passed)
}

/** Extract structured EVAL summary from parsed blocks for consumption by evaluator model. */
function evalSummary(blocks: EvalBlock[]): string {
  if (blocks.length === 0) return '(no EVAL blocks found)'
  const passed = blocks.filter(b => b.passed).length
  return [
    `Pre-parsed EVAL metrics (${passed}/${blocks.length} passed):`,
    ...blocks.map(b => `- ${b.metric}: ${b.valueTarget} → ${b.passed ? '✓' : '✗'}`),
  ].join('\n')
}

// --- Core evaluator ---

/**
 * Optimized goal evaluator.
 *
 * Strategy:
 * 1. Regex-parse EVAL blocks from recent assistant text. If all metrics
 *    pass → short-circuit satisfied without calling evaluator model.
 * 2. Feed pre-parsed EVAL summary to Haiku-4.5 for fallback evaluation.
 */
export async function evaluateGoal(
  goalCondition: string,
  messages: MessageType[],
): Promise<GoalEvalResult> {
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

  // Phase 1: regex-parse EVAL blocks from recent output (fast, no model call)
  const evalBlocks = parseEvalBlocks(recentAssistantTexts)

  // If ALL named metrics pass, the agent itself confirms goal completion.
  if (evalBlocks.length > 0 && allMetricsPassing(evalBlocks)) {
    return {
      satisfied: true,
      reason: `all ${evalBlocks.length} EVAL metrics satisfied`,
      gap: null,
    }
  }

  // If no EVAL blocks found at all, provide helpful guidance to the user
  if (evalBlocks.length === 0) {
    return {
      satisfied: false,
      reason: 'No EVAL blocks found in assistant output',
      gap: 'Please output EVAL blocks in format: "EVAL: metric: value / target → ✓" (without > prefix)',
    }
  }

  // Phase 2: Fallback to Haiku evaluator with pre-parsed summary
  const evalInput = [
    evalSummary(evalBlocks),
    '(note: EVAL blocks already pre-parsed above — use to guide your evaluation)',
    '',
    recentAssistantTexts.slice(-4000), // trim long messages to fit context
  ].join('\n')

  const client = new Anthropic({
    baseURL: process.env.ANTHROPIC_BASE_URL ?? undefined,
    apiKey: process.env.ANTHROPIC_API_KEY ?? 'dummy',
  })

  const prompt = `Goal condition to evaluate: "${goalCondition}"

The assistant's recent output is below. Based ONLY on it, determine if the goal is satisfied.

RESPOND WITH ONLY VALID JSON — no markdown, no explanation:
{"satisfied": true|false, "reason": "<one sentence why>", "gap": "<what's still missing, or null if satisfied>"}

${evalInput.slice(0, 5000)}`

  let text = ''
  try {
    const response = await client.messages.create({
      model: GOAL_EVALUATOR_MODEL,
      max_tokens: 256,
      messages: [{ role: 'user', content: prompt }],
    })
    text = response.content.find((b: any) => b.type === 'text')?.text || ''
  } catch (e) {
    // Short-circuit on API error — parse what we can
    return {
      satisfied: false,
      reason: 'Evaluator API error',
      gap: e instanceof Error ? e.message : String(e),
    }
  }

  // Phase 3: Parse evaluator output back to JSON.
  // Try strict JSON first, then fuzzy extraction, then interpret heuristics.
  const parseError = (detail: string): GoalEvalResult => ({
    satisfied: false,
    reason: 'Evaluator parse error',
    gap: `Failed to parse evaluator output. Detail: ${detail}. First 120 chars of raw response: ${text.slice(0, 120)}`,
  })

  const tryJsonParse = (raw: string): { ok: true; value: GoalEvalResult } | { ok: false } => {
    try {
      let cleaned = raw
        .replace(/```(?:json)?\s*/gi, '')
        .replace(/```/g, '')
        .trim()
      const start = cleaned.indexOf('{')
      const end = cleaned.lastIndexOf('}')
      if (start === -1 || end === -1 || end <= start) return { ok: false }
      cleaned = cleaned.slice(start, end + 1)
      const parsed = JSON.parse(cleaned)
      if (typeof parsed.satisfied === 'boolean') {
        return {
          ok: true,
          value: {
            satisfied: parsed.satisfied,
            reason: parsed.reason || '',
            gap: parsed.gap || null,
          },
        }
      }
      return { ok: false }
    } catch {
      return { ok: false }
    }
  }

  // Attempt 1 — strict JSON parse of the raw text
  const result = tryJsonParse(text)
  if (result.ok) return result.value

  // Attempt 2 — heuristic extraction from text response
  const lower = text.toLowerCase()
  const looksSatisfied =
    lower.includes('"satisfied": true') ||
    (lower.includes('satisfied') && lower.includes('true')) ||
    /goal\s+is\s+(?:met|satisfied|achieved)/.test(lower) ||
    /condition\s+is\s+(?:met|satisfied|fulfilled)/.test(lower)

  const extractString = (field: string): string => {
    const regex = new RegExp(`"${field}"\\s*:\\s*"([^"]*)"`, 'i')
    const match = text.match(regex)
    return match ? match[1] : 'unknown'
  }

  return {
    satisfied: looksSatisfied,
    reason: extractString('reason') || (looksSatisfied ? 'condition matched' : 'condition not met'),
    gap: extractString('gap') || null,
  }
}