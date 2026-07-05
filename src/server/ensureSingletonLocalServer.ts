// server/ensureSingletonLocalServer.ts
import { spawn } from 'child_process';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import axios from 'axios';

type Handle = {
  baseUrl: string;
  stopIfLast: () => Promise<void>;
  pid?: number;
};

const RUNTIME_DIR = path.join(os.homedir(), '.claude-cli', 'runtime');
const LOCK_JSON = path.join(RUNTIME_DIR, 'server.lock.json');
const BOOT_LOCK = path.join(RUNTIME_DIR, 'server.boot.lock');
const LEASES_DIR = path.join(RUNTIME_DIR, 'leases');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = Number(process.env.SERVER_PORT || 3456);
const HEALTH_TIMEOUT_MS = Number(process.env.HEALTH_TIMEOUT_MS || 20000);
const HEALTH_RETRY_MS = 300;

function mkdirp(p: string) { fs.mkdirSync(p, { recursive: true }); }
function atomicCreate(p: string): boolean {
  try { const fd = fs.openSync(p, 'wx'); fs.closeSync(fd); return true; } catch { return false; }
}
function rmSafe(p: string) { try { fs.rmSync(p, { force: true, recursive: true }); } catch {} }
function readJson<T>(p: string): T | null { try { return JSON.parse(fs.readFileSync(p, 'utf-8')) as T; } catch { return null; } }
function writeJson(p: string, data: any) { fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8'); }
function isPidAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
async function waitHealthy(baseUrl: string, timeoutMs: number) {
  const start = Date.now(); let lastErr: any = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await axios.get(baseUrl.replace(/\/+$/, '') + '/health', { timeout: 1500 });
      if (r.status === 200 && r.data?.status === 'ok') return;
    } catch (e) { lastErr = e; }
    await new Promise(r => setTimeout(r, HEALTH_RETRY_MS));
  }
  throw new Error(`Health check timeout: ${lastErr?.message || 'unknown'}`);
}
function resolveBunPath(): string {
  // 优先环境变量
  const fromEnv = process.env.BUN_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  // Windows：纯文件系统查找 bun.exe，无子进程，无 DEP0190 警告
  if (process.platform === 'win32') {
    const home = os.homedir();
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const candidates = [
      path.join(appData, 'npm', 'node_modules', 'bun', 'bin', 'bun.exe'),
      path.join(home, '.bun', 'bin', 'bun.exe'),
    ];
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      candidates.push(path.join(dir, 'bun.exe'));
    }
    for (const c of candidates) {
      try { if (fs.existsSync(c)) return c; } catch (_) {}
    }
  } else {
    // Linux/macOS：遍历 PATH 查找 bun
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      const c = path.join(dir, 'bun');
      try { if (fs.existsSync(c)) return c; } catch (_) {}
    }
  }

  throw new Error('Bun not detected. Please install via: npm install -g bun');
}

async function acquireLease(): Promise<string> {
  mkdirp(LEASES_DIR);
  const lease = path.join(LEASES_DIR, `${process.pid}.json`);
  await fsp.writeFile(lease, JSON.stringify({ pid: process.pid, ts: Date.now() }));
  const cleanup = () => rmSafe(lease);
  process.once('exit', cleanup);
  process.once('SIGINT', () => { cleanup(); process.exit(130); });
  process.once('SIGTERM', () => { cleanup(); process.exit(143); });
  return lease;
}
function countValidLeases(): number {
  try {
    const files = fs.readdirSync(LEASES_DIR);
    let alive = 0;
    for (const f of files) {
      const p = path.join(LEASES_DIR, f);
      const data = readJson<{pid:number, ts:number}>(p);
      if (data?.pid && isPidAlive(data.pid)) alive++;
      else rmSafe(p);
    }
    return alive;
  } catch { return 0; }
}

export async function ensureSingletonLocalServer(opts: {
  serverEntry: string;
  host?: string;
  port?: number;
  baseUrlEnv?: string;
  passEnv?: Record<string, string>;
}): Promise<Handle> {
  const preset = (opts.baseUrlEnv || process.env.BASE_API_URL || '').trim();
  if (preset) {
    try { await waitHealthy(preset, 3000); } catch {}
    await acquireLease();
    return { baseUrl: preset.replace(/\/+$/, ''), stopIfLast: async () => {} };
  }

  const host = opts.host || DEFAULT_HOST;
  const port = Number(opts.port ?? DEFAULT_PORT);
  const baseUrl = `http://${host}:${port}`;
  mkdirp(RUNTIME_DIR);

  const lock = readJson<{ pid:number, port:number }>(LOCK_JSON);
  if (lock && lock.port === port) {
    const healthy = await (async () => { try { await waitHealthy(baseUrl, 1200); return true; } catch { return false; } })();
    if (healthy && isPidAlive(lock.pid)) {
      await acquireLease();
      return { baseUrl, stopIfLast: makeStopIfLast(lock.pid, baseUrl), pid: lock.pid };
    }
    rmSafe(LOCK_JSON);
  }

  const iAmSpawner = atomicCreate(BOOT_LOCK);
  if (!iAmSpawner) {
    try { await waitHealthy(baseUrl, HEALTH_TIMEOUT_MS); } catch {
      rmSafe(BOOT_LOCK); rmSafe(LOCK_JSON);
      return await ensureSingletonLocalServer(opts);
    }
    await acquireLease();
    const live = readJson<{pid:number}>(LOCK_JSON);
    return { baseUrl, stopIfLast: makeStopIfLast(live?.pid || 0, baseUrl), pid: live?.pid };
  }

  let child: any = null;
  try {
    const bun = resolveBunPath();
    child = spawn(
      bun,
      [opts.serverEntry, '--host', host, '--port', String(port)],
      {
        env: { ...process.env, SERVER_AUTH_REQUIRED: '0', ...(opts.passEnv || {}) },
        stdio: 'ignore',
        detached: true,
      }
    );
    child.unref();
    await waitHealthy(baseUrl, HEALTH_TIMEOUT_MS);
    writeJson(LOCK_JSON, { pid: child.pid, port, startedAt: new Date().toISOString() });
  } catch (e) {
    if (child?.pid) {
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F']);
        else process.kill(child.pid, 'SIGTERM');
      } catch {}
    }
    throw e;
  } finally {
    rmSafe(BOOT_LOCK);
  }

  await acquireLease();
  return { baseUrl, stopIfLast: makeStopIfLast(child.pid, baseUrl), pid: child.pid };
}

function makeStopIfLast(serverPid: number, baseUrl: string) {
  return async () => {
    // Last client exiting — stop the server
    if (countValidLeases() > 0) return;
    // Try graceful shutdown via /exit first
    try {
      await axios.post(baseUrl.replace(/\/+$/, '') + '/exit', {}, { timeout: 3000 });
    } catch { /* server may already be gone */ }
    // Hard kill fallback
    try {
      if (isPidAlive(serverPid)) {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/PID', String(serverPid), '/T', '/F']);
        } else {
          process.kill(serverPid, 'SIGTERM');
        }
      }
    } catch { /* already dead */ }
    // Clean up daemon.lock (used by tray to track server ownership)
    const daemonLock = path.join(RUNTIME_DIR, 'daemon.lock');
    rmSafe(daemonLock);
  };
}
