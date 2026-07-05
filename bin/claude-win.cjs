#!/usr/bin/env node

const { spawn } = require('node:child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

// 使 Windows bun/spawn 更可靠
process.env.NoDefaultCurrentDirectoryInExePath = '1';

// ── 首次部署：将默认 bingo 配置复制到 ~/.claude/bingo/ ──
(function deployBingoDefaults() {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const bingoDir = path.join(configDir, 'bingo');
  const targetSettings = path.join(bingoDir, 'settings.json');

  if (!fs.existsSync(targetSettings)) {
    const defaultsDir = path.join(__dirname, '..', 'config', 'bingo-defaults');
    const srcSettings = path.join(defaultsDir, 'settings.json');

    if (fs.existsSync(srcSettings)) {
      try {
        if (!fs.existsSync(bingoDir)) {
          fs.mkdirSync(bingoDir, { recursive: true });
        }
        fs.copyFileSync(srcSettings, targetSettings);
        console.log('[claude] 首次启动：已部署默认配置到', targetSettings);
      } catch (err) {
        console.warn('[claude] 部署默认配置失败:', err.message);
      }
    }
  }
})();

// 自动定位 bun.exe（纯文件系统查找，无子进程，无 DEP0190 警告）
function resolveBunExe() {
  // 1. 用户指定路径
  if (process.env.BUN_PATH && fs.existsSync(process.env.BUN_PATH)) {
    return process.env.BUN_PATH;
  }
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const candidates = [
    // npm install -g bun 的真实 exe（最常见）
    path.join(appData, 'npm', 'node_modules', 'bun', 'bin', 'bun.exe'),
    // bun 官方安装脚本位置
    path.join(home, '.bun', 'bin', 'bun.exe'),
  ];
  // 遍历 PATH 中每个目录查找 bun.exe
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    candidates.push(path.join(dir, 'bun.exe'));
  }
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (_) {}
  }
  return null;
}

const bun = resolveBunExe();
if (!bun) {
  console.error('[claude] 找不到 bun.exe，请先执行: npm install -g bun');
  process.exit(1);
}

// 主 CLI 入口
const entry = path.join(__dirname, '..', 'src', 'entrypoints', 'cli.tsx');

// preload shim（定义 MACRO 全局变量）——必须用绝对路径，bunfig.toml 在 npm 全局安装后不生效
const preload = path.join(__dirname, '..', 'preload.ts');
if (!fs.existsSync(preload)) {
  console.error('[bingocode] 找不到 preload.ts，MACRO 将无法注入：' + preload);
  process.exit(1);
}

// 检查 .env 是否存在，自动加环境变量参数
let envFlag = '';
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  envFlag = `--env-file=${envPath}`;
}

// 拼接全部参数：preload、主文件、env、传入参数
const extraArgs = process.argv.slice(2);
const args = [`--preload=${preload}`, envFlag, entry, ...extraArgs].filter(Boolean); // 过滤空串

// 启动 bun
const child = spawn(bun, args, { stdio: 'inherit' });

child.on('exit', (code) => process.exit(code));
