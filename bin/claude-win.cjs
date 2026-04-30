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

// 自动定位 bun 路径（优先用环境变量，再检查默认安装位置，最后 fallback 到 PATH）
const bunPath =
  process.env.BUN_PATH ||
  path.join(os.homedir(), '.bun', 'bin', 'bun.exe');
const bun = fs.existsSync(bunPath) ? bunPath : 'bun';

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
