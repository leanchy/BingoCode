/**
 * Goal Drift Detector — alignment monitoring for agent behavior.
 *
 * Computes consistency scores between the agent's current actions and its
 * declared goals. Tracks trends over time and generates warnings when
 * behavior starts deviating from the target.
 *
 * Used by the goal system to detect when an agent should replan rather
 * than continue executing blind.
 */

import type { DriftAssessment, DriftWarning } from '../types/goal.js'
import type { SubGoal } from '../types/goal.js'

// ============================================================================
// Config
// ============================================================================

const DRIFT_HISTORY_SIZE = 5

let driftHistory: DriftAssessment[] = []

// ============================================================================
// Core assessment
// ============================================================================

/**
 * Assess whether the agent's current action aligns with its declared goals.
 * Returns a DriftAssessment with score, trend, and warnings.
 *
 * @param currentAction - what the agent just did (tool output, message text)
 * @param currentSubGoal - the SubGoal this action should serve
 * @param operationalGoal - the overarching execution contract
 */
export function assessDrift(
  currentAction: string,
  currentSubGoal: SubGoal,
  operationalGoal: string,
): DriftAssessment {
  // Step 1: Extract keyword sets from each layer
  const actionWords = extractKeywords(currentAction)
  const subGoalWords = extractKeywords(currentSubGoal.text)
  const opGoalWords = extractKeywords(operationalGoal)

  // Step 2: Compute pairwise similarity scores
  const actionToSub = jaccardSimilarity(actionWords, subGoalWords)
  const actionToOp = jaccardSimilarity(actionWords, opGoalWords)

  // Step 3: Weighted overall score (sub-goal alignment is more important)
  const consistencyScore = Math.round((actionToSub * 0.7 + actionToOp * 0.3) * 100)

  // Step 4: Track trend
  const assessment: DriftAssessment = {
    consistencyScore,
    currentAction,
    targetSubGoal: currentSubGoal.text,
    operationalGoal,
    trend: 'stable',
    warnings: [],
  }

  driftHistory.push(assessment)
  if (driftHistory.length > DRIFT_HISTORY_SIZE) {
    driftHistory.shift()
  }

  // Step 5: Compute trend from history
  assessment.trend = computeTrend(driftHistory.map(d => d.consistencyScore))

  // Step 6: Generate warnings if declining
  assessment.warnings = generateWarnings(consistencyScore, assessment.trend, currentAction, currentSubGoal, operationalGoal)

  return assessment
}

// ============================================================================
// Helpers
// ============================================================================

/** Extract meaningful keywords from arbitrary text.
 *  Strips stop words and normalizes to lowercase tokens. */
/** Extract meaningful keywords from arbitrary text.
 *  Supports both English and CJK (Chinese/Japanese/Korean) via Unicode
 *  property escapes. Strips common stop words in both languages. */
function extractKeywords(text: string): Set<string> {
  // English + CJK stop words
  const stopWords = new Set([
    // English
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
    'can', 'could', 'should', 'may', 'might', 'to', 'of', 'in',
    'for', 'on', 'at', 'by', 'with', 'from', 'or', 'and', 'not',
    'but', 'if', 'then', 'else', 'when', 'where', 'how', 'what',
    'this', 'that', 'these', 'those', 'it', 'its',
    // Chinese (common function words)
    '的', '了', '是', '在', '我', '有', '和', '就', '不', '人',
    '都', '一', '个', '上', '也', '很', '到', '说', '要', '去',
    '你', '会', '着', '没有', '看', '好', '自己', '这', '他',
    '她', '它', '们', '那', '什么', '怎么', '如何', '为什么',
    '因为', '所以', '但是', '虽然', '如果', '可以', '还', '已经',
    '这个', '那个', '这些', '那些', '这里', '那里', '哪', '吗',
    '吧', '啊', '呢', '哦', '嗯',
  ])

  // Step 1: Normalize to lowercase
  const normalized = text.toLowerCase()

  // Step 2: Extract CJK bigrams (2-char sequences) for Chinese/Japanese
  // This captures semantic units like "工具", "生成", "检测"
  const cjkBigrams: string[] = []
  let prevCjk = ''
  for (const ch of normalized) {
    const isCjk = /\p{Script=Han}/u.test(ch) || /\p{Script=Katakana}/u.test(ch) || /\p{Script=Hiragana}/u.test(ch)
    if (isCjk) {
      if (prevCjk) {
        cjkBigrams.push(prevCjk + ch)
      }
      prevCjk = ch
    } else {
      if (prevCjk) {
        // Single CJK char also counts (not filtered by length=1)
        cjkBigrams.push(prevCjk)
      }
      prevCjk = ''
    }
  }
  if (prevCjk) cjkBigrams.push(prevCjk)

  // Step 3: Extract English/ASCII words (preserved by Unicode-safe replace)
  const asciiPart = normalized.replace(/[^\p{L}\p{N}\s]/gu, ' ')
  const asciiWords = asciiPart
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w))

  // Step 4: Merge CJK bigrams + ASCII words, deduplicate
  const allTokens = new Set([...cjkBigrams, ...asciiWords])

  return allTokens
}

/** Jaccard similarity coefficient: |A ∩ B| / |A ∪ B|.
 *  Returns 0 if either set is empty. */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0

  let intersection = 0
  for (const word of a) {
    if (b.has(word)) intersection++
  }

  const unionSize = a.size + b.size - intersection
  return unionSize > 0 ? intersection / unionSize : 0
}

// ============================================================================
// Trend computation
// ============================================================================

/** Compute trend direction from a series of consistency scores.
 *  Uses simple moving average with threshold of 5 points. */
function computeTrend(scores: number[]): DriftAssessment['trend'] {
  if (scores.length < 2) return 'stable'

  const firstHalf = scores.slice(0, Math.floor(scores.length / 2))
  const secondHalf = scores.slice(Math.floor(scores.length / 2))

  const firstAvg = average(firstHalf)
  const secondAvg = average(secondHalf)

  const delta = secondAvg - firstAvg

  if (delta > 5) return 'improving'
  if (delta < -5) return 'declining'
  return 'stable'
}

function average(nums: number[]): number {
  if (nums.length === 0) return 0
  return nums.reduce((a, b) => a + b, 0) / nums.length
}

// ============================================================================
// Warning generation
// ============================================================================

/** Generate warnings based on consistency score and trend.
 *  Returns actionable suggestions for the agent. */
function generateWarnings(
  score: number,
  trend: DriftAssessment['trend'],
  currentAction: string,
  currentSubGoal: SubGoal,
  operationalGoal: string,
): DriftWarning[] {
  const warnings: DriftWarning[] = []

  // Thresholds
  if (score >= 80) return warnings // healthy — no warnings

  if (score < 50 && trend === 'declining') {
    warnings.push({
      severity: 'high',
      message: `Severe drift detected: current action "${currentAction.slice(0, 100)}" has low alignment (${score}%) with both sub-goal "${currentSubGoal.text}" and operational goal "${operationalGoal}". Consider immediate replanning.`,
      suggestedAction: 'replan',
    })
  } else if (score < 50) {
    warnings.push({
      severity: 'medium',
      message: `Moderate drift: action "${currentAction.slice(0, 100)}" may not be serving goal "${currentSubGoal.text}" (score: ${score}%). Review next steps.`,
      suggestedAction: 'replan',
    })
  } else if (score < 70) {
    warnings.push({
      severity: 'low',
      message: `Minor drift: alignment score ${score}% with target "${currentSubGoal.text}". Monitor for improvement.`,
      suggestedAction: 'continue',
    })
  }

  if (trend === 'declining' && warnings.length === 0) {
    warnings.push({
      severity: 'low',
      message: `Trend declining — score dropped below 80%. Current action may be wandering.`,
      suggestedAction: 'continue',
    })
  }

  return warnings
}

// ============================================================================
// Public API
// ============================================================================

/** Reset drift history (e.g., when goal changes or session restarts). */
export function resetDriftHistory(): void {
  driftHistory = []
}

/** Get the current drift history for debugging/inspection. */
export function getDriftHistory(): ReadonlyArray<DriftAssessment> {
  return driftHistory as ReadonlyArray<DriftAssessment>
}
