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

// 检查 bun 是否可用
function bunExists() {
  return resolveBunExe() !== null;
}

// 安装 bun（通过 npm install -g bun）
function installBun() {
  console.log('[bingocode] bun 未检测到，正在通过 npm install -g bun 安装...');

  try {
    const npmResult = spawnSync(
      'npm.cmd',
      ['install', '-g', 'bun', '--loglevel', 'error'],
      { stdio: 'inherit' }
    );
    if (npmResult.status !== 0) {
      throw new Error(`npm install -g bun 失败，exit code ${npmResult.status}`);
    }

    console.log('[bingocode] bun 安装完成，正在启动...');
    return true;
  } catch (err) {
    console.error(`[bingocode] bun 自动安装失败: ${err.message}`);
    console.log('[bingocode] 请手动安装 bun: npm install -g bun');
    return false;
  }
}

if (!bunExists()) {
  if (!installBun()) {
    process.exit(1);
  }
}

// 安装完成后重新解析 bun 路径
const bunExe = resolveBunExe();
if (!bunExe) {
  console.error('[bingocode] 安装后仍找不到 bun.exe，请重新打开终端后再试，或手动安装 bun: npm install -g bun');
  process.exit(1);
}

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

// ── Start tray daemon if not already running ────────────────────────────────
const RUNTIME_DIR = path.join(os.homedir(), '.claude-cli', 'runtime');
const DAEMON_LOCK_FILE = path.join(RUNTIME_DIR, 'daemon.lock');

function serverHealthy() {
  return new Promise((resolve) => {
    const http = require('http');
    const req = http.get('http://127.0.0.1:3456/health', { timeout: 1000 }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve(res.statusCode === 200 && JSON.parse(data).status === 'ok');
        } catch {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => { req.destroy(); resolve(false); });
  });
}

function isDaemonAlive() {
  try {
    const pid = parseInt(fs.readFileSync(DAEMON_LOCK_FILE, 'utf-8').trim(), 10);
    process.kill(pid, 0); // signal 0 == probe only
    return true;
  } catch {
    return false;
  }
}

const CHECK_MS = 3000;

async function startTrayDaemonIfNeeded() {
  // Daemon PID lock prevents race: only one daemon runs across multiple bingo launches
  if (isDaemonAlive()) {
    console.log('[bingo] Daemon already running, skipping daemon start');
    return;
  }

  // stale lock cleanup
  try { fs.unlinkSync(DAEMON_LOCK_FILE); } catch {}

  console.log('[bingo] Starting tray daemon...');
  const trayEntry = path.join(ROOT_DIR, 'src', 'entrypoints', 'tray-only.ts');
  const daemon = spawn(bunExe, ['--preload=' + preload, trayEntry], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  });
  daemon.unref();

  // Wait for health check
  const start = Date.now();
  while (Date.now() - start < CHECK_MS) {
    if (await serverHealthy()) {
      console.log('[bingo] Tray daemon started successfully');
      break;
    }
    await (new Promise((r) => setTimeout(r, 300)));
  }
}

// Start daemon, then launch CLI independently
startTrayDaemonIfNeeded().catch(() => {});

// ── Launch CLI (connects to existing server) ───────────────────────────────
const args = [`--preload=${preload}`, envFlag, entry, ...extraArgs].filter(Boolean);

// 用绝对路径 spawn，不依赖 shell 解析 PATH
const child = spawn(bunExe, args, { stdio: 'inherit' });
