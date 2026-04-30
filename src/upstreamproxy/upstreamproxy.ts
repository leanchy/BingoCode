/**
 * CCR upstreamproxy — container-side wiring.
 *
 * When running inside a CCR session container with upstreamproxy configured,
 * this module:
 *   1. Reads the session token from /run/ccr/session_token
 *   2. Sets prctl(PR_SET_DUMPABLE, 0) to block same-UID ptrace of the heap
 *   3. Downloads the upstreamproxy CA cert and concatenates it with the
 *      system bundle so curl/gh/python trust the MITM proxy
 *   4. Starts a local CONNECT→WebSocket relay (see relay.ts)
 *   5. Unlinks the token file (token stays heap-only; file is gone before
 *      the agent loop can see it, but only after the relay is confirmed up
 *      so a supervisor restart can retry)
 *   6. Exposes HTTPS_PROXY / SSL_CERT_FILE env vars for all agent subprocesses
 *
 * Every step fails open: any error logs a warning and disables the proxy.
 * A broken proxy setup must never break an otherwise-working session.
 *
 * Design doc: api-go/ccr/docs/plans/CCR_AUTH_DESIGN.md § "Week-1 pilot scope".
 */

//@C: ID=M.up.index;K=M;V=1.0;P=Module imports and configuration;D=Networking;M=UpstreamProxy;S=Container Wiring
import { mkdir, readFile, unlink, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { registerCleanup } from '../utils/cleanupRegistry.js'
import { logForDebugging } from '../utils/debug.js'
import { isEnvTruthy } from '../utils/envUtils.js'
import { isENOENT } from '../utils/errors.js'
import { startUpstreamProxyRelay } from './relay.js'

export const SESSION_TOKEN_PATH = '/run/ccr/session_token'
const SYSTEM_CA_BUNDLE = '/etc/ssl/certs/ca-certificates.crt'

// Hosts the proxy must NOT intercept. Covers loopback, RFC1918, the IMDS
// range, and the package registries + GitHub that CCR containers already
// reach directly. Mirrors airlock/scripts/sandbox-shell-ccr.sh.
const BASE_NO_PROXY = [
  'localhost',
  '127.0.0.1',
  '::1',
  '169.254.0.0/16',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  'github.com',
  'api.github.com',
  '*.github.com',
  '*.githubusercontent.com',
  'registry.npmjs.org',
  'pypi.org',
  'files.pythonhosted.org',
  'index.crates.io',
  'proxy.golang.org',
]
const shouldBlockAnthropic =
  isEnvTruthy(process.env.BLOCK_PROXY_ANTHROPIC) ||
  (process.env.ALLOW_PROXY_ANTHROPIC ? !isEnvTruthy(process.env.ALLOW_PROXY_ANTHROPIC) : false)

const ANTHROPIC_NO_PROXY = ['anthropic.com', '.anthropic.com', '*.anthropic.com']
const NO_PROXY_LIST = [...BASE_NO_PROXY, ...(shouldBlockAnthropic ? ANTHROPIC_NO_PROXY : [])].join(',')

//@C: ID=T.up.Types;K=T;V=1.0;P=Type definitions;D=Networking;M=UpstreamProxy;S=Container Wiring
type UpstreamProxyState = {
  enabled: boolean
  port?: number
  caBundlePath?: string
}

//@C: ID=M.up.state;K=M;V=1.0;P=Module state;D=Networking;M=UpstreamProxy;S=Container Wiring
let state: UpstreamProxyState = { enabled: false }

//@C: ID=F.up.initUpstreamProxy;K=F;V=1.0;P=Initialize upstream proxy inside container;D=Networking;M=UpstreamProxy;S=Container Wiring;In={tokenPath?:string,systemCaPath?:string,caBundlePath?:string,ccrBaseUrl?:string}|undefined;Out=Promise<UpstreamProxyState>
/**
 * Initialize upstreamproxy. Called once from init.ts. Safe to call when the
 * feature is off or the token file is absent — returns {enabled: false}.
 *
 * Overridable paths are for tests; production uses the defaults.
 */
export async function initUpstreamProxy(opts?: {
  tokenPath?: string
  systemCaPath?: string
  caBundlePath?: string
  ccrBaseUrl?: string
}): Promise<UpstreamProxyState> {
  console.log("F.up.initUpstreamProxy")
  ///@C:up.feature-gates
  const forceEnable =
    isEnvTruthy(process.env.UPSTREAMPROXY_FORCE_ENABLE) ||
    !!process.env.UPSTREAMPROXY_BASE_URL

  if (!isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) && !forceEnable) {
    return state
  }
  if (!isEnvTruthy(process.env.CCR_UPSTREAM_PROXY_ENABLED) && !forceEnable) {
    return state
  }

  ///@C:up.read-session-id
  const sessionId = process.env.UPSTREAMPROXY_SESSION_ID || process.env.CLAUDE_CODE_REMOTE_SESSION_ID
  if (!sessionId) {
    logForDebugging(
      '[upstreamproxy] session id unset; proxy disabled',
      { level: 'warn' },
    )
    return state
  }

  ///@C:up.read-token
  const tokenPath = opts?.tokenPath ?? SESSION_TOKEN_PATH
  const envToken = (process.env.UPSTREAMPROXY_TOKEN || '').trim()
  const token = envToken ? envToken : await readToken(tokenPath)
  if (!token) {
    logForDebugging('[upstreamproxy] no session token available; proxy disabled')
    return state
  }

  ///@C:up.harden-process
  setNonDumpable()

  ///@C:up.resolve-paths
  // CCR injects ANTHROPIC_BASE_URL via StartupContext (sessionExecutor.ts /
  // sessionHandler.ts). getOauthConfig() is wrong here: it keys off
  // USER_TYPE + USE_{LOCAL,STAGING}_OAUTH, none of which the container sets,
  // so it always returned the prod URL and the CA fetch 404'd.
  const relayBaseFromEnv =
    process.env.UPSTREAMPROXY_BASE_URL ||
    process.env.LLM_PROXY_BASE_URL ||
    undefined

  const baseUrl =
    opts?.ccrBaseUrl ??
    relayBaseFromEnv ??
    'https://api.anthropic.com'

  try {
    const anthBase = process.env.ANTHROPIC_BASE_URL
    if (
      anthBase &&
      !/\.?anthropic\.com$/i.test(new URL(anthBase).hostname) &&
      !process.env.UPSTREAMPROXY_BASE_URL &&
      !process.env.UPSTREAMPROXY_WS_URL
    ) {
      logForDebugging(
        '[config] ANTHROPIC_BASE_URL 指向非 Anthropic；上游代理请用 UPSTREAMPROXY_BASE_URL 或 UPSTREAMPROXY_WS_URL。',
        { level: 'warn' },
      )
    }
  } catch { /* ignore */ }

  const caBundlePath =
    opts?.caBundlePath ?? join(homedir(), '.ccr', 'ca-bundle.crt')

  ///@C:up.download-ca
  const skipCa = isEnvTruthy(process.env.UPSTREAMPROXY_SKIP_CA)
  const caOk = skipCa
    ? true
    : await downloadCaBundle(
        baseUrl,
        opts?.systemCaPath ?? SYSTEM_CA_BUNDLE,
        caBundlePath,
      )
  if (!caOk) return state

  ///@C:up.start-relay-and-cleanup
  try {
    const wsUrl =
      process.env.UPSTREAMPROXY_WS_URL ||
      (baseUrl.replace(/^http/, 'ws') + '/v1/code/upstreamproxy/ws')

    const relay = await startUpstreamProxyRelay({ wsUrl, sessionId, token })
    registerCleanup(async () => relay.stop())
    state = {
      enabled: true,
      port: relay.port,
      caBundlePath: skipCa ? undefined : caBundlePath,
    }
    logForDebugging(`[upstreamproxy] enabled on 127.0.0.1:${relay.port}`)
    if (isEnvTruthy(process.env.UPSTREAMPROXY_EXPORT_ENV)) {
      const env = getUpstreamProxyEnv()
      for (const [k, v] of Object.entries(env)) process.env[k] = v
      logForDebugging('[upstreamproxy] exported proxy env to current process')
    }
    await unlink(tokenPath).catch(() => {
      logForDebugging('[upstreamproxy] token file unlink failed', {
        level: 'warn',
      })
    })
  } catch (err) {
    logForDebugging(
      `[upstreamproxy] relay start failed: ${err instanceof Error ? err.message : String(err)}; proxy disabled`,
      { level: 'warn' },
    )
  }

  ///@C:up.return-state
  return state
}

//@C: ID=F.up.getUpstreamProxyEnv;K=F;V=1.0;P=Build env vars for subprocesses;D=Networking;M=UpstreamProxy;S=Container Wiring;In=void;Out=Record<string,string>
/**
 * Env vars to merge into every agent subprocess. Empty when the proxy is
 * disabled. Called from subprocessEnv() so Bash/MCP/LSP/hooks all inherit
 * the same recipe.
 */
export function getUpstreamProxyEnv(): Record<string, string> {
  console.log("F.up.getUpstreamProxyEnv")
  ///@C:up.disabled-or-inherit
  if (!state.enabled || !state.port) {
    if (process.env.HTTPS_PROXY && process.env.SSL_CERT_FILE) {
      const inherited: Record<string, string> = {}
      for (const key of [
        'HTTPS_PROXY',
        'https_proxy',
        'NO_PROXY',
        'no_proxy',
        'SSL_CERT_FILE',
        'NODE_EXTRA_CA_CERTS',
        'REQUESTS_CA_BUNDLE',
        'CURL_CA_BUNDLE',
      ]) {
        if (process.env[key]) inherited[key] = process.env[key]!
      }
      return inherited
    }
    return {}
  }

  ///@C:up.enabled-build-env
  const proxyUrl = `http://127.0.0.1:${state.port}`
  const env: Record<string, string> = {
    HTTPS_PROXY: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: NO_PROXY_LIST,
    no_proxy: NO_PROXY_LIST,
  }
  if (state.caBundlePath) {
    env.SSL_CERT_FILE = state.caBundlePath
    env.NODE_EXTRA_CA_CERTS = state.caBundlePath
    env.REQUESTS_CA_BUNDLE = state.caBundlePath
    env.CURL_CA_BUNDLE = state.caBundlePath
  }
  return env
}

//@C: ID=F.up.resetUpstreamProxyForTests;K=F;V=1.0;P=Reset module state (tests only);D=Networking;M=UpstreamProxy;S=Container Wiring;In=void;Out=void
/** Test-only: reset module state between test cases. */
export function resetUpstreamProxyForTests(): void {
  console.log("F.up.resetUpstreamProxyForTests")
  ///@C:up.reset-state
  state = { enabled: false }
}

//@C: ID=F.up.readToken;K=F;V=1.0;P=Read session token from disk;D=Networking;M=UpstreamProxy;S=Container Wiring;In=string;Out=Promise<string|null>
async function readToken(path: string): Promise<string | null> {
  console.log("F.up.readToken")
  ///@C:up.try-read
  try {
    const raw = await readFile(path, 'utf8')
    return raw.trim() || null
  } catch (err) {
    if (isENOENT(err)) return null
    logForDebugging(
      `[upstreamproxy] token read failed: ${err instanceof Error ? err.message : String(err)}`,
      { level: 'warn' },
    )
    return null
  }
}

//@C: ID=F.up.setNonDumpable;K=F;V=1.0;P=Disable core dumps (prctl PR_SET_DUMPABLE=0);D=Security;M=UpstreamProxy;S=Container Wiring;In=void;Out=void
/**
 * prctl(PR_SET_DUMPABLE, 0) via libc FFI. Blocks same-UID ptrace of this
 * process, so a prompt-injected `gdb -p $PPID` can't scrape the token from
 * the heap. Linux-only; silently no-ops elsewhere.
 */
function setNonDumpable(): void {
  console.log("F.up.setNonDumpable")
  ///@C:up.platform-guard
  if (process.platform !== 'linux' || typeof Bun === 'undefined') return
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ffi = require('bun:ffi') as typeof import('bun:ffi')
    const lib = ffi.dlopen('libc.so.6', {
      prctl: {
        args: ['int', 'u64', 'u64', 'u64', 'u64'],
        returns: 'int',
      },
    } as const)
    const PR_SET_DUMPABLE = 4
    const rc = lib.symbols.prctl(PR_SET_DUMPABLE, 0n, 0n, 0n, 0n)
    if (rc !== 0) {
      logForDebugging(
        '[upstreamproxy] prctl(PR_SET_DUMPABLE,0) returned nonzero',
        {
          level: 'warn',
        },
      )
    }
  } catch (err) {
    logForDebugging(
      `[upstreamproxy] prctl unavailable: ${err instanceof Error ? err.message : String(err)}`,
      { level: 'warn' },
    )
  }
}

//@C: ID=F.up.downloadCaBundle;K=F;V=1.0;P=Fetch upstreamproxy CA and write merged bundle;D=Networking;M=UpstreamProxy;S=Container Wiring;In=string,string,string;Out=Promise<boolean>
async function downloadCaBundle(
  baseUrl: string,
  systemCaPath: string,
  outPath: string,
): Promise<boolean> {
  console.log("F.up.downloadCaBundle")
  ///@C:up.fetch-ca
  try {
    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    const resp = await fetch(`${baseUrl}/v1/code/upstreamproxy/ca-cert`, {
      // Bun has no default fetch timeout — a hung endpoint would block CLI
      // startup forever. 5s is generous for a small PEM.
      signal: AbortSignal.timeout(5000),
    })
    if (!resp.ok) {
      logForDebugging(
        `[upstreamproxy] ca-cert fetch ${resp.status}; proxy disabled`,
        { level: 'warn' },
      )
      return false
    }
    ///@C:up.concat-and-write
    const ccrCa = await resp.text()
    const systemCa = await readFile(systemCaPath, 'utf8').catch(() => '')
    await mkdir(join(outPath, '..'), { recursive: true })
    await writeFile(outPath, systemCa + '\n' + ccrCa, 'utf8')
    return true
  } catch (err) {
    logForDebugging(
      `[upstreamproxy] ca-cert download failed: ${err instanceof Error ? err.message : String(err)}; proxy disabled`,
      { level: 'warn' },
    )
    return false
  }
}
