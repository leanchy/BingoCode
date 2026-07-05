/**
 * Goal Evaluator v2 — environment-aware assessment for goal progress.
 *
 * Replaces the text-only evaluator with a 3-tier system:
 *   1. Rule Engine (deterministic checks — file existence, test output, etc.)
 *   2. Semantic Evaluation (Haiku-level — interprets evidence against goal)
 *   3. Final Verification (main model — for ambiguous cases)
 *
 * Still supports the EVAL block format for agent self-reporting, but now
 * also reads actual tool results, file diffs, and system state to verify
 * progress independently of what the agent claims.
 */

import Anthropic from '@anthropic-ai/sdk'
import { statSync } from 'fs'
import type { MessageType } from '../components/messages.js'
import type {
  EvaluationContext,
  EvalResult,
  EvalEvidence,
  RuleCheck,
  ToolResult,
  FileDiff,
  TestOutput,
  CompileOutput,
  GitStatus,
  ErrorLog,
} from '../types/goal.js'
import type { SubGoal, GoalDag } from '../types/goal.js'
import { getGoalState } from './goalStore.js'
import type { GoalState } from '../types/goal.js'

// ============================================================================
// Model constants
// ============================================================================

export const GOAL_EVALUATOR_MODEL = 'claude-haiku-4-5'
const EVAL_MAX_TOKENS = 512

// ============================================================================
// Client factory
// ============================================================================

function createClient(): Anthropic {
  return new Anthropic({
    baseURL: process.env.ANTHROPIC_BASE_URL ?? undefined,
    apiKey: process.env.ANTHROPIC_API_KEY ?? undefined,
  })
}

// ============================================================================
// EVAL Block Parser (retained from v1)
// ============================================================================

type EvalBlock = {
  metric: string
  valueTarget: string
  passed: boolean
}

const arrow = /(?:→|->|=>)/g.source
const pass = /(?:✓|✔|PASS|pass|Y\b|true|yes|1)/g.source
const fail = /(?:✗|✘|FAIL|fail|N\b|false|no|0)/g.source
const full = new RegExp(
  `(?:^|\\n)\\s*(?:>)?\\s*EVAL:\\s*(.+?):\\s*(.+?)\\s*(?:${arrow}|)\\s*(${pass}|${fail})`,
  'gm',
)

function parseEvalBlocks(text: string): EvalBlock[] {
  const blocks: EvalBlock[] = []
  let match: RegExpExecArray | null
  while ((match = full.exec(text)) !== null) {
    const [, metric, valueTarget, signal] = match
    const passed = /^(✓|✔|PASS|pass|Y\b|true|yes|1)$/.test(signal.trim())
    blocks.push({ metric: metric.trim(), valueTarget: valueTarget.trim(), passed })
  }
  return blocks
}

function allMetricsPassing(blocks: EvalBlock[]): boolean {
  return blocks.length > 0 && blocks.every(b => b.passed)
}

function evalSummary(blocks: EvalBlock[]): string {
  if (blocks.length === 0) return '(no EVAL blocks found)'
  const passed = blocks.filter(b => b.passed).length
  return [
    `Pre-parsed EVAL metrics (${passed}/${blocks.length} passed):`,
    ...blocks.map(b => `- ${b.metric}: ${b.valueTarget} → ${b.passed ? '✓' : '✗'}`),
  ].join('\n')
}

// ============================================================================
// Core evaluation
// ============================================================================

/**
 * Evaluate goal progress with environment-aware assessment.
 *
 * Strategy:
 *   1. Parse EVAL blocks from recent assistant output (fast, no API call)
 *   2. If all metrics pass → short-circuit satisfied
 *   3. Otherwise, build evaluation context and run rule checks
 *   4. If still ambiguous, call Haiku for semantic evaluation
 *   5. For critical goals, optionally escalate to main model
 */
export async function evaluateGoal(
  goalCondition: string,
  messages: MessageType[],
  subGoal?: SubGoal,
): Promise<EvalResult> {
  // Extract recent assistant messages for EVAL parsing
  const recentAssistantTexts = extractAssistantTexts(messages)

  // Phase 1: Parse EVAL blocks from agent self-reports
  const evalBlocks = parseEvalBlocks(recentAssistantTexts)

  // Short-circuit: all metrics pass → goal satisfied
  if (evalBlocks.length > 0 && allMetricsPassing(evalBlocks)) {
    return {
      satisfied: true,
      level: 'rule',
      reason: `all ${evalBlocks.length} EVAL metrics satisfied`,
      gap: null,
      evidence: evalBlocks.map(b => ({
        source: 'agent-output',
        finding: `${b.metric}: ${b.valueTarget}`,
        relevanceScore: 1.0,
      })),
    }
  }

  // Phase 2: Build environment context
  const ctx = await buildEvaluationContext(messages)
  const evidenceFromEnv = gatherEvidence(ctx)

  // Phase 3: Check if there's enough evidence to decide
  if (evidenceFromEnv.length > 0) {
    // Has the agent made concrete progress? Check key signals.
    const hasConcreteProgress = checkConcreteProgress(evidenceFromEnv, goalCondition)
    if (hasConcreteProgress.satisfied) {
      return {
        satisfied: true,
        level: 'rule',
        reason: 'Concrete progress detected from environment',
        gap: null,
        evidence: evidenceFromEnv,
      }
    }
  }

  // Phase 4: Semantic evaluation with Haiku
  const evalInput = buildEvalInput(goalCondition, evalBlocks, ctx, evidenceFromEnv, messages)
  const semanticResult = await callHaiku(goalCondition, evalInput)

  // If Haiku is confident either way, trust it
  if (semanticResult.satisfied || (!semanticResult.satisfied && evalBlocks.length === 0)) {
    return {
      ...semanticResult,
      level: 'semantic',
      evidence: [...evidenceFromEnv, ...semanticResult.evidence],
    }
  }

  // Phase 5: Fallback — not satisfied, escalate to main model for final check
  const finalResult = await callMainModel(goalCondition, ctx, evidenceFromEnv, messages)
  return {
    ...finalResult,
    level: 'final',
    evidence: [...evidenceFromEnv, ...finalResult.evidence],
  }
}

// ============================================================================
// Context builders
// ============================================================================

/** Extract text from the last 5 assistant messages for EVAL parsing. */
function extractAssistantTexts(messages: MessageType[]): string {
  return messages
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
}

/** Build a full evaluation context from recent messages. */
async function buildEvaluationContext(messages: MessageType[]): Promise<EvaluationContext> {
  const toolResults = extractRecentToolResults(messages)
  const fileDiffs = extractFileDiffs(messages)
  const testOutputs = extractTestOutputs(messages)
  const compileOutputs = extractCompileOutputs(messages)
  const gitStatus = await getGitStatus()
  const errorLogs = getRecentErrors()

  const fileList = getTrackedFiles(messages)

  return {
    toolResults,
    fileDiffs,
    testOutputs,
    compileOutputs,
    gitStatus,
    fileList,
    errorLogs,
  }
}

// ============================================================================
// Rule Engine — deterministic checks that produce evidence
// ============================================================================

/**
 * Built-in rule registry. Each rule is a pure function:
 *   (EvaluationContext, SubGoal) → EvalEvidence[]
 *
 * Rules are composable — the engine runs all registered rules and
 * aggregates their output. New rules can be added by extending this
 * registry (Phase 4: plugin system).
 */
const BUILT_IN_RULES: Record<string, (ctx: EvaluationContext, goal: import('../types/goal.js').SubGoal) => import('../types/goal.js').EvalEvidence[]> = {

  // === File existence ===

  /** Check if files mentioned in the goal exist on disk. Uses fs.accessSync
   *  to verify each file path without reading the content. */
  fileExists(ctx: EvaluationContext, _goal: import('../types/goal.js').SubGoal): import('../types/goal.js').EvalEvidence[] {
    const evidence: import('../types/goal.js').EvalEvidence[] = []
    for (const filePath of ctx.fileList) {
      try {
        statSync(filePath)
        evidence.push({
          source: 'filesystem',
          finding: `File exists: ${filePath}`,
          relevanceScore: 0.8,
        })
      } catch {
        // File doesn't exist — no evidence (missing file is not proof)
      }
    }
    return evidence
  },

  // === Test output ===

  /** Check if any test output indicates passing tests. Parses stdout/stderr
   *  for pass/fail patterns and produces evidence accordingly. */
  testsPass(ctx: EvaluationContext, _goal: import('../types/goal.js').SubGoal): import('../types/goal.js').EvalEvidence[] {
    const evidence: import('../types/goal.js').EvalEvidence[] = []
    for (const test of ctx.testOutputs) {
      if (test.passed) {
        evidence.push({
          source: 'test-runner',
          finding: `Tests passed: ${test.command} (exit ${test.exitCode})`,
          relevanceScore: 0.9,
        })
      } else {
        evidence.push({
          source: 'test-runner',
          finding: `Tests failed: ${test.command} (${test.stderr.slice(0, 200)})`,
          relevanceScore: 0.8,
        })
      }
    }
    return evidence
  },

  // === Compilation ===

  /** Check if build/compilation succeeded. Looks for successful build outputs
   *  in the compileOutputs array. */
  buildPassed(ctx: EvaluationContext, _goal: import('../types/goal.js').SubGoal): import('../types/goal.js').EvalEvidence[] {
    const evidence: import('../types/goal.js').EvalEvidence[] = []
    for (const compile of ctx.compileOutputs) {
      if (compile.passed) {
        evidence.push({
          source: 'compiler',
          finding: `Build passed: ${compile.command}`,
          relevanceScore: 0.9,
        })
      } else {
        evidence.push({
          source: 'compiler',
          finding: `Build failed: ${compile.command} — ${compile.stderr.slice(0, 200)}`,
          relevanceScore: 0.7,
        })
      }
    }
    return evidence
  },

  // === Schema validation ===

  /** Check if data schemas are valid. Currently checks TypeScript compilation
   *  errors in the error log and compile outputs as a proxy for schema validity.
   *  Future: integrate with actual schema validators (JSON Schema, Zod, etc.) */
  schemaValid(ctx: EvaluationContext, _goal: import('../types/goal.js').SubGoal): import('../types/goal.js').EvalEvidence[] {
    const evidence: import('../types/goal.js').EvalEvidence[] = []
    // Check for TypeScript errors as a proxy for type-safety
    for (const error of ctx.errorLogs) {
      if (error.error.includes('error TS')) {
        evidence.push({
          source: 'type-checker',
          finding: `TypeScript error: ${error.error.slice(0, 200)}`,
          relevanceScore: 0.6,
        })
      }
    }
    return evidence
  },
}

/** Run all built-in rules against the current evaluation context and target
 *  sub-goal. Returns combined evidence from all rule checks.
 *
 *  This is the engine that drives the rule-based evaluation tier.
 *  Future: add plugin registration for custom project-specific rules. */
function runRules(ctx: EvaluationContext, goal: import('../types/goal.js').SubGoal): import('../types/goal.js').EvalEvidence[] {
  const results: import('../types/goal.js').EvalEvidence[] = []

  // File existence rules
  results.push(...BUILT_IN_RULES.fileExists(ctx, goal))

  // Test output rules
  results.push(...BUILT_IN_RULES.testsPass(ctx, goal))

  // Build/compilation rules
  results.push(...BUILT_IN_RULES.buildPassed(ctx, goal))

  // Schema validation rules
  results.push(...BUILT_IN_RULES.schemaValid(ctx, goal))

  return results
}

// ============================================================================
// Evidence gathering
// ============================================================================

/** Generate a human-readable evaluation summary from context + evidence. */
function gatherEvidence(ctx: EvaluationContext): EvalEvidence[] {
  const evidence: EvalEvidence[] = []

  // Tool results → evidence
  for (const tr of ctx.toolResults) {
    if (!tr.success && tr.toolName !== 'Read') {
      evidence.push({
        source: tr.toolName,
        finding: `Tool ${tr.toolName} failed: ${tr.toolOutput.slice(0, 200)}`,
        relevanceScore: 0.7,
      })
    } else if (tr.success) {
      evidence.push({
        source: tr.toolName,
        finding: `Tool ${tr.toolName} succeeded`,
        relevanceScore: 0.5,
      })
    }
  }

  // File changes → evidence of progress
  for (const diff of ctx.fileDiffs) {
    if (diff.added > 0 || diff.changed > 0) {
      evidence.push({
        source: diff.path,
        finding: `Changed ${diff.path}: +${diff.added} -${diff.removed}`,
        relevanceScore: 0.6,
      })
    }
  }

  // Test outputs → strong signal
  for (const test of ctx.testOutputs) {
    evidence.push({
      source: 'test-runner',
      finding: test.passed
        ? `Tests passed: ${test.command}`
        : `Tests failed: ${test.command} (exit ${test.exitCode})`,
      relevanceScore: test.passed ? 0.9 : 0.8,
    })
  }

  // Compile outputs → strong signal
  for (const compile of ctx.compileOutputs) {
    evidence.push({
      source: 'compiler',
      finding: compile.passed
        ? `Build passed: ${compile.command}`
        : `Build failed: ${compile.command} — ${compile.stderr.slice(0, 200)}`,
      relevanceScore: compile.passed ? 0.9 : 0.8,
    })
  }

  return evidence
}

// ============================================================================
// Haiku evaluation
// ============================================================================

async function callHaiku(
  goalCondition: string,
  evalInput: string,
): Promise<EvalResult> {
  try {
    const client = createClient()
    const response = await client.messages.create({
      model: GOAL_EVALUATOR_MODEL,
      max_tokens: EVAL_MAX_TOKENS,
      system: `You are a goal evaluator. Determine if the goal "${goalCondition}" is satisfied based on the evidence provided. Respond ONLY with valid JSON.`,
      messages: [{ role: 'user', content: evalInput.slice(0, 4000) }],
    })

    const text = response.content.find((b: any) => b.type === 'text')?.text || ''
    const parsed = parseEvalResponse(text)
    return {
      satisfied: parsed.satisfied ?? false,
      level: 'semantic',
      reason: parsed.reason ?? 'No reason provided',
      gap: parsed.gap ?? null,
      evidence: [],
    }
  } catch (err) {
    return {
      satisfied: false,
      level: 'semantic',
      reason: `Evaluator API error: ${err instanceof Error ? err.message : String(err)}`,
      gap: 'API call failed',
      evidence: [],
    }
  }
}

// ============================================================================
// Main model evaluation (final tier)
// ============================================================================

async function callMainModel(
  goalCondition: string,
  ctx: EvaluationContext,
  evidence: EvalEvidence[],
  messages: MessageType[],
): Promise<EvalResult> {
  try {
    const client = createClient()
    const summary = buildEvaluationSummary(goalCondition, ctx, evidence, messages)
    const response = await client.messages.create({
      model: getMainModel(),
      max_tokens: EVAL_MAX_TOKENS,
      system: `You are a goal evaluator. Assess whether the goal "${goalCondition}" is achieved based on the following evidence. Respond ONLY with valid JSON ({"satisfied": true/false, "reason": "...", "gap": "..."}). Be thorough — this is the final check before marking the goal complete.`,
      messages: [{ role: 'user', content: summary.slice(0, 4000) }],
    })

    const text = response.content.find((b: any) => b.type === 'text')?.text || ''
    const parsed = parseEvalResponse(text)
    return {
      satisfied: parsed.satisfied ?? false,
      level: 'final',
      reason: parsed.reason ?? 'No reason provided',
      gap: parsed.gap ?? null,
      evidence,
    }
  } catch (err) {
    return {
      satisfied: false,
      level: 'final',
      reason: `Final evaluator error: ${err instanceof Error ? err.message : String(err)}`,
      gap: 'API call failed',
      evidence,
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

/** Get the main model name from environment or default. */
function getMainModel(): string {
  return process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6-20250514'
}

/** Parse evaluation response JSON. Handles markdown and prefix text. */
function parseEvalResponse(text: string): { satisfied?: boolean; reason?: string; gap?: string | null } {
  try {
    let cleaned = text
      .replace(/```(?:json)?\s*/gi, '')
      .replace(/```/g, '')
      .trim()
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start !== -1 && end !== -1 && end > start) {
      cleaned = cleaned.slice(start, end + 1)
      const parsed = JSON.parse(cleaned)
      return {
        satisfied: !!parsed.satisfied,
        reason: parsed.reason || '',
        gap: parsed.gap || null,
      }
    }
    return {}
  } catch {
    return {}
  }
}

/** Build comprehensive evaluation input for Haiku from context + evidence. */
function buildEvalInput(
  goalCondition: string,
  evalBlocks: EvalBlock[],
  ctx: EvaluationContext,
  evidence: EvalEvidence[],
  messages: MessageType[],
): string {
  const parts: string[] = []

  // EVAL blocks summary
  if (evalBlocks.length > 0) {
    parts.push(evalSummary(evalBlocks))
  }

  // Evidence summary
  if (evidence.length > 0) {
    parts.push(`Environmental evidence (${evidence.length} findings):`)
    parts.push(...evidence.map(e => `- ${e.source}: ${e.finding} [${e.relevanceScore.toFixed(1)}]`))
  }

  // Recent agent output
  const recentTexts = extractAssistantTexts(messages).slice(-2000)
  if (recentTexts) {
    parts.push(`Recent agent output:\n${recentTexts}`)
  }

  return parts.join('\n')
}

// ============================================================================
// Environment extraction helpers (from messages)
// ============================================================================

function extractRecentToolResults(messages: MessageType[]): ToolResult[] {
  const results: ToolResult[] = []
  for (const msg of messages) {
    if (msg.type === 'assistant' || msg.role === 'assistant') {
      const content = msg.message?.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_result') {
            results.push({
              toolName: block.tool_name ?? 'unknown',
              toolInput: (block as any).tool_input ?? {},
              toolOutput: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
              success: !(block as any).is_error,
              timestamp: Date.now(),
            })
          }
        }
      }
    }
  }
  return results
}

function extractFileDiffs(messages: MessageType[]): FileDiff[] {
  const diffs: FileDiff[] = []
  for (const msg of messages) {
    if (msg.type === 'assistant' || msg.role === 'assistant') {
      const content = msg.message?.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_result' && block.tool_name === 'Bash') {
            const text = typeof block.content === 'string' ? block.content : ''
            if (text.includes('diff --git')) {
              diffs.push(parseDiffLine(text))
            }
          }
          if (block.type === 'text') {
            const text = block.text
            if (text.includes('added') && text.includes('removed')) {
              diffs.push(parseEditStats(text))
            }
          }
        }
      }
    }
  }
  return diffs
}

/** Parse a git diff --stat line into FileDiff counts. */
function parseDiffLine(text: string): FileDiff {
  const match = text.match(/^diff --git a\/(.*) b\/(.*)$/m)
  let added = 0; let removed = 0; let changed = 0

  for (const line of text.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) added++
    else if (line.startsWith('-')) removed++
    else changed++
  }

  return {
    path: match?.[1] ?? 'unknown',
    added,
    removed,
    changed,
  }
}

function extractTestOutputs(messages: MessageType[]): TestOutput[] {
  const outputs: TestOutput[] = []
  for (const msg of messages) {
    if (msg.type === 'user' || msg.role === 'user') {
      // Check user messages for injected test output (from test runner hooks)
      const text = typeof msg.message?.content === 'string'
        ? msg.message.content
        : Array.isArray(msg.message?.content)
          ? msg.message.content.map((b: any) => b.text ?? '').join('\n')
          : ''
      if (text.includes('PASS') || text.includes('FAIL')) {
        outputs.push({
          command: extractCommand(text),
          exitCode: text.includes('FAIL') ? 1 : 0,
          stdout: text,
          stderr: '',
          passed: !text.includes('FAIL'),
        })
      }
    }
  }
  return outputs
}

function extractCompileOutputs(messages: MessageType[]): CompileOutput[] {
  const outputs: CompileOutput[] = []
  for (const msg of messages) {
    if (msg.type === 'user' || msg.role === 'user') {
      const text = typeof msg.message?.content === 'string'
        ? msg.message.content
        : ''
      if (text.includes('error TS') || text.includes('Error: ') || text.includes('BUILD FAILED')) {
        outputs.push({
          command: extractCommand(text),
          exitCode: 1,
          stdout: '',
          stderr: text,
          passed: false,
        })
      }
    }
  }
  return outputs
}

/** Extract the command that produced this output. */
function extractCommand(text: string): string {
  const match = text.match(/^(?:> |\$ )?(.+?)(?:\n|$)/)
  return match?.[1] ?? 'unknown'
}

/** Parse edit stats from agent text (e.g., "Modified 3 files: +45 -12"). */
function parseEditStats(text: string): FileDiff {
  const m = text.match(/\+(\d+)\s*-\s*(\d+)/)
  return {
    path: 'unknown',
    added: m ? parseInt(m[1]) : 0,
    removed: m ? parseInt(m[2]) : 0,
    changed: 0,
  }
}

// ============================================================================
// Git status
// ============================================================================

async function getGitStatus(): Promise<GitStatus> {
  try {
    // Use child_process directly to avoid circular imports
    const { execSync } = await import('child_process')
    const output = execSync('git status --porcelain', { encoding: 'utf8', cwd: process.cwd() })
    const lines = output.trim().split('\n').filter(Boolean)
    return {
      staged: lines.filter(l => l[0] !== ' ' && l[1] !== ' ').map(l => l.slice(3)),
      unstaged: lines.filter(l => l[0] === ' ' || l[1] === ' ').map(l => l.slice(3)),
      untracked: lines.filter(l => l.startsWith('??')).map(l => l.slice(3)),
      branch: execSync('git branch --show-current', { encoding: 'utf8' }).trim(),
      clean: lines.length === 0,
    }
  } catch {
    return { staged: [], unstaged: [], untracked: [], branch: '', clean: true }
  }
}

// ============================================================================
// System state accessors
// ============================================================================

/** Get tracked files from goal store artifacts and git status. */
function getTrackedFiles(messages: MessageType[]): string[] {
  // Combine artifacts from goal store with any files mentioned in recent tool calls
  const files = new Set<string>()
  for (const msg of messages) {
    if (msg.type === 'user' || msg.role === 'user') continue
    const content = msg.message?.content
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_result') {
          // Extract file paths from tool results (e.g., "Wrote to file.txt")
          const text = typeof block.content === 'string' ? block.content : ''
          const paths = extractFilePaths(text)
          for (const p of paths) files.add(p)
        }
      }
    }
  }
  return Array.from(files)
}

/** Extract file paths from tool output text. */
function extractFilePaths(text: string): string[] {
  const paths: string[] = []
  // Match patterns like "Wrote contents to /path/to/file.txt"
  const wroteMatch = /(?:Wrote|Saved|Created)\s+(?:contents\s+)?(?:to\s+)?([^\s]+)/gi
  let match: RegExpExecArray | null
  while ((match = wroteMatch.exec(text)) !== null) {
    paths.push(match[1])
  }
  return paths
}

/** Get recent errors from the in-memory error log ring buffer. */
function getRecentErrors(): ErrorLog[] {
  try {
    // Access the global STATE via bootstrap
    const { getState } = require('../bootstrap/state.js')
    // The inMemoryErrorLog field exists on the STATE object
    const errors = (getState() as any).inMemoryErrorLog ?? []
    return errors.slice(-20).map((e: any) => ({ error: e.error, timestamp: e.timestamp }))
  } catch {
    return []
  }
}

// ============================================================================
// Progress checking
// ============================================================================

/** Check if there's concrete progress in the environment that indicates
 *  the goal is likely achieved. */
function checkConcreteProgress(
  evidence: EvalEvidence[],
  goalCondition: string,
): { satisfied: boolean; reason: string } {
  // If no evidence at all, can't claim progress
  if (evidence.length === 0) {
    return { satisfied: false, reason: 'No environmental evidence found' }
  }

  // Check for strong positive signals
  const hasSuccessfulTool = evidence.some(e => e.relevanceScore >= 0.8)
  const hasCodeChange = evidence.some(e => e.source === 'test-runner' || e.source === 'compiler')
  const hasFileOutput = evidence.some(e => e.source !== 'agent-output')

  if (hasSuccessfulTool || hasCodeChange || hasFileOutput) {
    return { satisfied: true, reason: `Concrete progress detected (${evidence.length} signals)` }
  }

  return { satisfied: false, reason: 'Insufficient concrete progress evidence' }
}

// ============================================================================
// State accessors (delegate to goal store)
// ============================================================================

/** Get the current goal state for evaluation context building. */
function getGoalStateSnapshot(): GoalState {
  try {
    return getGoalState()
  } catch {
    return {
      activeGoalId: null,
      userGoal: null,
      operationalGoal: null,
      dag: { nodes: new Map(), edges: [], readyQueue: [] },
      immediateGoal: null,
      progress: 0,
      artifacts: [],
      metrics: { totalSubGoals: 0, completedSubGoals: 0, iterationCount: 0, maxIterations: 20, evalHistory: { lastGap: null, consecutiveSameGapCount: 0 } },
    }
  }
}

// Keep backwards compatibility with existing exports used by useGoalEvaluator.ts
export { parseEvalBlocks as parseEvalBlocks_legacy, allMetricsPassing, evalSummary }
