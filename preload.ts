// 优先用环境变量，其次从 package.json 读取真实版本号
import { readFileSync } from 'fs'
import { join } from 'path'
let _pkgVersion = '1.0.0'
try {
  const _pkgPath = join(import.meta.dir, 'package.json')
  const _pkg = JSON.parse(readFileSync(_pkgPath, 'utf-8')) as { version?: string }
  if (_pkg.version) _pkgVersion = _pkg.version
} catch { /* ignore */ }
const version = process.env.CLAUDE_CODE_LOCAL_VERSION ?? _pkgVersion;
const packageUrl = process.env.CLAUDE_CODE_LOCAL_PACKAGE_URL ?? 'claude-code-local';
const buildTime = process.env.CLAUDE_CODE_LOCAL_BUILD_TIME ?? new Date().toISOString();

process.env.CLAUDE_CODE_LOCAL_SKIP_REMOTE_PREFETCH ??= '1';

Object.assign(globalThis, {
  MACRO: {
    VERSION: version,
    PACKAGE_URL: packageUrl,
    NATIVE_PACKAGE_URL: packageUrl,
    BUILD_TIME: buildTime,
    FEEDBACK_CHANNEL: 'local',
    VERSION_CHANGELOG: '',
    ISSUES_EXPLAINER: '',
  },
});
// Switch to the current workspace
if (process.env.CALLER_DIR) {
  process.chdir(process.env.CALLER_DIR);
}