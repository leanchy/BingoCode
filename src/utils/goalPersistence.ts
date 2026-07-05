/**
 * Goal persistence layer — file-based save/load for goal state.
 *
 * Stores goal state in .claude/goals/<goalId>.json. Independent of the
 * memory system (which is for long-term knowledge, not task tracking).
 *
 * Thread-safe: writes use rename-overwrite to avoid corruption on crash.
 * Small files (<10KB) so synchronous IO is acceptable — no async needed.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync, existsSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { getProjectRoot } from '../bootstrap/state.js'
import type { GoalState, GoalId } from '../types/goal.js'

const GOALS_DIR_NAME = '.claude/goals'
const ARCHIVE_DIR_NAME = 'archive'

/** Resolve the absolute path to the goals directory. */
function getGoalsDir(): string {
  const projectRoot = getProjectRoot()
  return join(projectRoot, GOALS_DIR_NAME)
}

/** Resolve the absolute path to a specific goal file. */
export function getGoalFilePath(id: GoalId): string {
  return join(getGoalsDir(), `${id}.json`)
}

/** Ensure the goals directory exists. Idempotent — safe to call repeatedly. */
export function ensureGoalsDir(): void {
  const dir = getGoalsDir()
  mkdirSync(dir, { recursive: true })
}

/** Ensure the archive subdirectory exists. */
export function ensureArchiveDir(): void {
  const dir = join(getGoalsDir(), ARCHIVE_DIR_NAME)
  mkdirSync(dir, { recursive: true })
}

// ============================================================================
// Serialized format — wraps GoalState with version metadata
// ============================================================================

/** On-disk format: versioned envelope around the raw state.
 *  Version is incremented on every save; readers can detect conflicts. */
interface VersionedGoalFile {
  version: number
  state: GoalState
}

/**
 * Save goal state to disk atomically with version tracking.
 * Uses write-then-rename pattern: write to a temp file first, then
 * rename into place. This prevents partial writes on crash.
 *
 * The version field is incremented on every write. Callers can use
 * the returned version for optimistic concurrency control.
 */
export function saveGoalState(state: GoalState): number {
  if (!state.activeGoalId) {
    throw new Error('Cannot save goal state without active goal ID')
  }

  ensureGoalsDir()

  const targetPath = getGoalFilePath(state.activeGoalId)
  const tmpPath = `${targetPath}.tmp`

  // Read current version, increment for this write
  const currentVersion = readVersion(state.activeGoalId)
  const newVersion = currentVersion + 1

  const envelope: VersionedGoalFile = { version: newVersion, state }
  const json = JSON.stringify(envelope, null, 2)
  writeFileSync(tmpPath, json, 'utf8')
  renameSync(tmpPath, targetPath)

  return newVersion
}

/**
 * Load goal state from disk. Returns null if the file does not exist
 * or is corrupted (invalid JSON).
 *
 * Reads both the state and its version number from the versioned
 * envelope format.
 */
export function loadGoalState(id: GoalId): GoalState | null {
  const path = getGoalFilePath(id)
  if (!existsSync(path)) return null

  try {
    const raw = readFileSync(path, 'utf8')
    const envelope = JSON.parse(raw) as VersionedGoalFile

    // Basic structural validation (on the inner state)
    validateGoalStateShape(envelope.state)

    return envelope.state as GoalState
  } catch {
    // Corrupted JSON or validation failure — return null
    return null
  }
}

/** Read just the version number from a goal file (without parsing the full state).
 *  Returns 0 if the file doesn't exist yet (brand-new goal). */
export function readVersion(id: GoalId): number {
  const path = getGoalFilePath(id)
  if (!existsSync(path)) return 0

  try {
    const raw = readFileSync(path, 'utf8')
    const envelope = JSON.parse(raw) as VersionedGoalFile
    return envelope.version ?? 0
  } catch {
    return 0
  }
}

/**
 * Save state only if the current on-disk version matches the expected version.
 * This provides optimistic concurrency control — if another writer has modified
 * the file since we last read it, the save is rejected (returns false).
 *
 * Returns the new version number on success, or -1 on conflict.
 */
export function saveIfUnchanged(expectedVersion: number, state: GoalState): number {
  if (!state.activeGoalId) {
    throw new Error('Cannot save goal state without active goal ID')
  }

  ensureGoalsDir()

  const targetPath = getGoalFilePath(state.activeGoalId)
  const currentVersion = readVersion(state.activeGoalId)

  if (currentVersion !== expectedVersion && currentVersion !== 0) {
    // Conflict: another writer changed the file since we last read it
    return -1
  }

  const newVersion = currentVersion + 1
  const envelope: VersionedGoalFile = { version: newVersion, state }
  const json = JSON.stringify(envelope, null, 2)

  const tmpPath = `${targetPath}.tmp`
  writeFileSync(tmpPath, json, 'utf8')
  renameSync(tmpPath, targetPath)

  return newVersion
}

/** List all saved goal files (return their IDs). */
export function listGoalFiles(): GoalId[] {
  const dir = getGoalsDir()
  if (!existsSync(dir)) return []

  return readdirSync(dir)
    .filter(f => f.endsWith('.json') && !f.startsWith('.'))
    .map(f => f.replace('.json', '') as GoalId)
}

/** Move a goal file to the archive subdirectory. */
export function archiveGoal(id: GoalId): void {
  ensureArchiveDir()
  const src = getGoalFilePath(id)
  const dst = join(getGoalsDir(), ARCHIVE_DIR_NAME, `${id}.json`)

  if (!existsSync(src)) return
  renameSync(src, dst)
}

/** Delete a goal file from disk. Irreversible. */
export function deleteGoal(id: GoalId): void {
  const path = getGoalFilePath(id)
  if (existsSync(path)) {
    unlinkSync(path)
  }
}

/**
 * Basic structural validation for loaded JSON.
 * Checks that required fields exist and have correct types.
 * Does NOT validate all nested fields — just enough to reject
 * obviously broken files.
 */
function validateGoalStateShape(parsed: unknown): void {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid goal state: not an object')
  }

  const obj = parsed as Record<string, unknown>

  if (typeof obj.activeGoalId !== 'string' && obj.activeGoalId !== null) {
    throw new Error('Invalid goal state: activeGoalId must be string or null')
  }
  if (typeof obj.progress !== 'number') {
    throw new Error('Invalid goal state: progress must be number')
  }
  if (!Array.isArray(obj.artifacts)) {
    throw new Error('Invalid goal state: artifacts must be array')
  }
}
