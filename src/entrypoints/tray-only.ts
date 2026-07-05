/**
 * tray-only.ts — 背景托盘入口（无 UI，系统托盘守护进程）
 *
 * 使用 systray2 渲染原生托盘图标，启动服务器，处理退出请求。
 * 关闭所有 CLI 时，服务器继续运行直到用户右键 Exit 退出。
 */
import SysTray from 'systray2';
import path from 'path';
import fs from 'fs';
import os from 'os';
import http from 'http';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../../');

const PORT = Number(process.env.BINGO_SERVER_PORT || 3456);
const HOST = process.env.BINGO_SERVER_HOST || '127.0.0.1';

let serverHandle: any = null;

// ── Autostart helpers (Windows Startup folder, fallback to registry) ────────
const STARTUP_DIR = path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const STARTUP_CMD = path.join(STARTUP_DIR, 'Bingo.cmd');
const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const REG_NAME = 'Bingo';

function isAutostartEnabled(): boolean {
  if (process.platform !== 'win32') return false;
  if (fs.existsSync(STARTUP_CMD)) return true;
  try {
    execSync(`reg query "${REG_KEY}" /v ${REG_NAME}`, { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function findBunExe(): string {
  const appData = process.env.APPDATA || '';
  const home = os.homedir();
  const candidates = [
    path.join(appData, 'npm', 'node_modules', 'bun', 'bin', 'bun.exe'),
    path.join(home, '.bun', 'bin', 'bun.exe'),
  ];
  // also search PATH
  for (const dir of (process.env.PATH || '').split(';')) {
    candidates.push(path.join(dir.trim(), 'bun.exe'));
  }
  return candidates.find(p => { try { return fs.existsSync(p); } catch { return false; } }) || 'bun';
}

function enableAutostart(): void {
  if (process.platform !== 'win32') return;
  const bunExe = findBunExe();
  const preload = path.join(ROOT_DIR, 'preload.ts');
  const trayEntry = path.join(ROOT_DIR, 'src', 'entrypoints', 'tray-only.ts');
  // Startup .cmd: launch tray daemon only (no CLI window)
  try {
    const cmd = [
      '@echo off',
      `start "" /B "${bunExe}" "--preload=${preload}" "${trayEntry}"`,
      '',
    ].join('\r\n');
    fs.writeFileSync(STARTUP_CMD, cmd, { encoding: 'utf8' });
    return;
  } catch {}
  // fallback: registry
  try {
    const val = `"${bunExe}" "--preload=${preload}" "${trayEntry}"`;
    execSync(`reg add "${REG_KEY}" /v ${REG_NAME} /t REG_SZ /d "${val}" /f`);
  } catch (e) {
    console.error('[tray] Failed to enable autostart:', e);
  }
}

function disableAutostart(): void {
  if (process.platform !== 'win32') return;
  try { fs.unlinkSync(STARTUP_CMD); } catch {}
  try { execSync(`reg delete "${REG_KEY}" /v ${REG_NAME} /f`, { stdio: 'ignore' }); } catch {}
}

// ── Daemon PID lock ──────────────────────────────────────────────────────
const DAEMON_LOCK_FILE = path.join(os.homedir(), '.claude-cli', 'runtime', 'daemon.lock');
try { fs.mkdirSync(path.dirname(DAEMON_LOCK_FILE), { recursive: true }); } catch {}
fs.writeFileSync(DAEMON_LOCK_FILE, String(process.pid), { flag: 'w' });
process.on('exit', () => {
  try { fs.unlinkSync(DAEMON_LOCK_FILE); } catch {}
});

// Tray icon: Windows=ICO, others=PNG
const _iconExt = process.platform === 'win32' ? 'ico' : 'png';
const _iconFile = path.join(ROOT_DIR, 'assets', `tray-icon.${_iconExt}`);
const _iconFallback = 'AAABAAEAEBAAAAEAIACEAAAAFgAAAIlQTkcNChoKAAAADUlIRFIAAAAQAAAAEAgGAAAAH/P/YQAAAEtJREFUeJxjYBi0QEFB4T8ypkgz0YYgK/5/wAAF4zUI3SZ0zdgMQTEIm0Z8hhFtADJNlgH0dwGyQfhcRVRskBSNVEtI+AwhSTNdAQA7QffzDDtFvQAAAABJRU5ErkJggg==';
const iconB64 = fs.existsSync(_iconFile)
  ? fs.readFileSync(_iconFile).toString('base64')
  : _iconFallback;

try {
  const autostartItem = {
    title: (isAutostartEnabled() ? '✓ ' : '') + 'Run on ststem startup',
    tooltip: 'Toggle auto-start Bingo on Windows login',
    checked: false,
    enabled: true,
  };

  const systray = new SysTray({
    menu: {
      icon: iconB64,
      title: 'Bingo',
      tooltip: 'Bingo is running',
      items: [
        {
          title: 'Server Running',
          tooltip: 'Bingo is running on port ' + PORT,
          checked: false,
          enabled: false,
        },
        autostartItem,
        {
          title: 'Exit Bingo',
          tooltip: 'Stop all bingo services',
          checked: false,
          enabled: true,
        },
      ],
    },
    debug: false,
    copyDir: true,
  });

  systray.onClick((action: any) => {
    if (action.item?.title?.includes('Start on Login')) {
      if (isAutostartEnabled()) {
        disableAutostart();
        autostartItem.title = 'Start on Login';
      } else {
        enableAutostart();
        autostartItem.title = '✓ Start on Login';
      }
      systray.sendAction({ type: 'update-item', item: autostartItem });
      return;
    }
    if (action.item?.title === 'Exit Bingo') {
      console.log('[tray] Exiting via tray menu');
      // try graceful server shutdown, then force exit regardless
      const req = http.request(
        `http://${HOST}:${PORT}/exit`,
        { method: 'POST', timeout: 3000 },
        () => {
          // server responded (any status) → kill tray + exit
          try { systray.kill(false); } catch {}
          process.exit(0);
        },
      );
      req.on('error', () => {
        // server unreachable → still exit
        try { systray.kill(false); } catch {}
        process.exit(0);
      });
      req.end();
    }
  });

} catch (e) {
  console.error('[tray] Failed to create systray:', e);
}

// ── Start the server ─────────────────────────────────────────────────────────
import { ensureSingletonLocalServer } from '../server/ensureSingletonLocalServer.js';
const serverEntry = path.join(ROOT_DIR, 'src', 'server', 'index.ts');

ensureSingletonLocalServer({ serverEntry, host: HOST, port: PORT })
  .then((handle: any) => {
    serverHandle = handle;
    console.log('[tray] Server started on http://' + HOST + ':' + PORT);
  })
  .catch((err: any) => {
    console.error('[tray] Failed to start server:', err.message || err);
  });

// Keep event loop alive indefinitely
setInterval(() => {}, 60_000);
