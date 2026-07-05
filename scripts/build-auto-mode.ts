#!/usr/bin/env bun
/**
 * 构建启用 Auto Mode (TRANSCRIPT_CLASSIFIER) 的 BingoCode 发行版本。
 *
 * 原理：
 *   - bun:bundle 的 feature() 是编译期宏，运行时永远返回 false。
 *   - 通过 Bun.build({ features: [...] }) 将 TRANSCRIPT_CLASSIFIER 内联为 true，
 *     dead-code elimination 后所有 auto mode 分支得以保留。
 *
 * 用法：
 *   bun run scripts/build-auto-mode.ts
 *   bun run scripts/build-auto-mode.ts --watch   # 监听源码变化自动重建
 *
 * 构建产物写入 dist/，bin/ 里的启动器会优先使用 dist/ 内的文件。
 */

import { join, relative } from 'path'
import { existsSync, mkdirSync } from 'fs'

const ROOT = join(import.meta.dir, '..')
const DIST = join(ROOT, 'dist')
const FEATURES: string[] = ['TRANSCRIPT_CLASSIFIER', 'BASH_CLASSIFIER']

const ENTRYPOINTS = [
  { name: 'cli',     src: join(ROOT, 'src', 'entrypoints', 'cli.tsx') },
  { name: 'manager', src: join(ROOT, 'src', 'entrypoints', 'manager.tsx') },
]

if (!existsSync(DIST)) mkdirSync(DIST, { recursive: true })

async function build(): Promise<boolean> {
  const start = Date.now()
  process.stdout.write(`[auto-mode] building with features: ${FEATURES.join(', ')}…\n`)

  const result = await Bun.build({
    entrypoints: ENTRYPOINTS.map(e => e.src),
    outdir: DIST,
    target: 'bun',
    packages: 'external',   // node_modules 不打包，保留 require()
    sourcemap: 'none',
    minify: false,           // 保留可读性，方便调试
    // @ts-ignore — Bun type defs lag behind actual API
    features: FEATURES,
  })

  const elapsed = Date.now() - start

  if (!result.success) {
    process.stderr.write(`[auto-mode] build FAILED (${elapsed}ms)\n`)
    for (const log of result.logs) {
      process.stderr.write(`  ${log.level}: ${log.message}\n`)
    }
    return false
  }

  for (const out of result.outputs) {
    process.stdout.write(`  ✓ ${relative(ROOT, out.path)}  (${(out.size / 1024).toFixed(1)} kB)\n`)
  }

  // ── Verification: confirm feature() macro substitution worked ──
  const verifyOutputs = result.outputs.filter(o => o.path.endsWith('.js'))
  let inlined = 0
  for (const feat of FEATURES) {
    // When Bun.build({ features: [...] }) works correctly, `feature("FEAT_NAME")`
    // in source becomes `true` in output and the string "FEAT_NAME" is absent.
    // If the string still appears, the feature was NOT inlined (DCE cliff or
    // missing build config).
    const stillPresent = verifyOutputs.filter(out => {
      const content = out.text?.()
      return content && content.includes(feat)
    })
    if (stillPresent.length > 0) {
      process.stdout.write(`  ⚠ "${feat}" string found in ${stillPresent.length} output(s) — NOT inlined. Check Bun DCE budget.\n`)
    } else {
      inlined++
    }
  }
  if (inlined === FEATURES.length) {
    process.stdout.write(`[auto-mode] build OK in ${elapsed}ms (features inlined: ${inlined}/${FEATURES.length})\n`)
  } else {
    process.stdout.write(`[auto-mode] build OK in ${elapsed}ms (features inlined: ${inlined}/${FEATURES.length}, see warnings above)\n`)
  }
  return true
}

// ── Watch mode ────────────────────────────────────────────────────────────────
const isWatch = process.argv.includes('--watch')

if (isWatch) {
  const { watch } = await import('fs')
  process.stdout.write('[auto-mode] watch mode — rebuilding on src/ changes\n')

  let debounce: ReturnType<typeof setTimeout> | null = null
  watch(join(ROOT, 'src'), { recursive: true }, (_event, filename) => {
    if (!filename?.match(/\.(ts|tsx)$/)) return
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(async () => {
      process.stdout.write(`\n[auto-mode] change: ${filename}\n`)
      await build()
    }, 300)
  })

  // Initial build
  const ok = await build()
  if (!ok) process.exit(1)
} else {
  const ok = await build()
  process.exit(ok ? 0 : 1)
}
