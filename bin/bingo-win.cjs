#!/usr/bin/env node

const { spawn, spawnSync } = require('node:child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.NoDefaultCurrentDirectoryInExePath = '1';

// ── 首次部署：将默认 bingo 配置复制到 ~/.claude/bingo/ ──
/**
 * 更加健壮的根目录定位：
 * 1. 如果 preload.ts 在 ../ (当前 bin/ 目录下运行)
 * 2. 否则查找同级及上级目录中的 package.json
 */
function getProjectRoot() {
  let curr = __dirname;
  try {
    while (curr !== path.dirname(curr)) {
      if (fs.existsSync(path.join(curr, 'preload.ts')) || fs.existsSync(path.join(curr, 'package.json'))) {
        return curr;
      }
      const parent = path.dirname(curr);
      if (fs.existsSync(path.join(parent, 'preload.ts'))) return parent;
      curr = parent;
    }
  } catch (err) {
    // 防止权限拒绝等导致挂死
  }
  return path.join(__dirname, '..');
}

const ROOT_DIR = getProjectRoot();

(function deployBingoDefaults() {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const bingoDir = path.join(configDir, 'bingo');
  const targetSettings = path.join(bingoDir, 'settings.json');

  // 只在 settings.json 不存在时才部署
  if (!fs.existsSync(targetSettings)) {
    const defaultsDir = path.join(ROOT_DIR, 'config', 'bingo-defaults');
    const srcSettings = path.join(defaultsDir, 'settings.json');

    if (fs.existsSync(srcSettings)) {
      try {
        if (!fs.existsSync(bingoDir)) {
          fs.mkdirSync(bingoDir, { recursive: true });
        }
        fs.copyFileSync(srcSettings, targetSettings);
        console.log('[bingo] 首次启动：已部署默认配置到', targetSettings);
      } catch (err) {
        console.warn('[bingo] 部署默认配置失败:', err.message);
      }
    }
  }
})();

// 自动定位 bun 路径
const bunPath =
  process.env.BUN_PATH ||
  path.join(os.homedir(), '.bun', 'bin', 'bun.exe');

// 检查 bun 是否可用
function bunExists() {
  if (fs.existsSync(bunPath)) return true;
  try {
    const result = spawnSync('bun', ['--version'], { stdio: 'ignore', shell: true });
    return result.status === 0;
  } catch (e) {
    return false;
  }
}

// 安装 bun（通过 npm 拉取官方包，不走 GitHub/bun.sh）
function installBun() {
  console.log('[bingocode] bun 未检测到，正在通过 npm 安装...');

  // 用 npm install 拉取平台对应包，安装到临时目录后复制 bun.exe
  const tmpDir = path.join(os.tmpdir(), 'bingocode-bun-install');
  try {
    fs.mkdirSync(tmpDir, { recursive: true });

    // npm install @oven/bun-windows-x64 到临时目录
    const npmResult = spawnSync(
      'npm',
      ['install', '@oven/bun-windows-x64', '--prefix', tmpDir, '--no-save', '--loglevel', 'error'],
      { stdio: 'inherit', shell: true }
    );
    if (npmResult.status !== 0) {
      throw new Error(`npm install 失败，exit code ${npmResult.status}`);
    }

    // 从 node_modules 复制 bun.exe → ~/.bun/bin/bun.exe
    const src = path.join(tmpDir, 'node_modules', '@oven', 'bun-windows-x64', 'bin', 'bun.exe');
    if (!fs.existsSync(src)) {
      throw new Error(`未找到 ${src}`);
    }
    const destDir = path.dirname(bunPath);
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(src, bunPath);

    console.log('[bingocode] bun 安装完成，正在启动...');
    return true;
  } catch (err) {
    console.error(`[bingocode] bun 自动安装失败: ${err.message}`);
    console.log('[bingocode] 请手动安装 bun: npm install -g @oven/bun-windows-x64');
    return false;
  } finally {
    // 清理临时目录（非阻塞）
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

if (!bunExists()) {
  if (!installBun()) {
    process.exit(1);
  }
}

// 安装后 bun.exe 在固定位置；若在 PATH 里则直接用 "bun"
const bun = fs.existsSync(bunPath) ? bunPath : 'bun';

// Bingo Manager 入口
const entry = path.join(ROOT_DIR, 'src', 'entrypoints', 'manager.tsx');

// preload shim
const preload = path.join(ROOT_DIR, 'preload.ts');
if (!fs.existsSync(preload)) {
  console.error('[bingocode] 找不到 preload.ts，MACRO 将无法注入：' + preload);
  process.exit(1);
}

// 检查 .env
let envFlag = '';
const envPath = path.join(ROOT_DIR, '.env');
if (fs.existsSync(envPath)) {
  envFlag = `--env-file=${envPath}`;
}

const extraArgs = process.argv.slice(2);
const args = [`--preload=${preload}`, envFlag, entry, ...extraArgs].filter(Boolean);

const child = spawn(bun, args, { stdio: 'inherit' });

child.on('exit', (code) => process.exit(code));
