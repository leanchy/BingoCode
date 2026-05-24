#!/usr/bin/env node
/**
 * postinstall: copy bundled skills from .claude/skills/ → ~/.claude/skills/
 *
 * Rules:
 *   - Skips any skill directory that already exists (never overwrites user edits).
 *   - Silently exits in CI / headless environments where $HOME is unset.
 *   - CJS so it runs on any Node version without flags or transpilation.
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const home = os.homedir()
if (!home) process.exit(0)

const pkgRoot = path.resolve(__dirname, '..')
const srcSkillsDir = path.join(pkgRoot, '.claude', 'skills')
const dstSkillsDir = path.join(
  process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'),
  'skills',
)

if (!fs.existsSync(srcSkillsDir)) process.exit(0)

const skills = fs.readdirSync(srcSkillsDir, { withFileTypes: true })
  .filter(e => e.isDirectory())
  .map(e => e.name)

for (const skill of skills) {
  const dst = path.join(dstSkillsDir, skill)

  try {
    fs.mkdirSync(dst, { recursive: true })
    const src = path.join(srcSkillsDir, skill)
    for (const file of fs.readdirSync(src)) {
      fs.copyFileSync(path.join(src, file), path.join(dst, file))
    }
    console.log(`[bingocode] installed skill: ${skill}`)
  } catch (err) {
    // Non-fatal: log and continue
    console.warn(`[bingocode] could not install skill ${skill}: ${err.message}`)
  }
}

