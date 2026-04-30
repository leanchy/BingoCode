/* eslint-disable eslint-plugin-n/no-unsupported-features/node-builtins */
/**
 * CONNECT-over-WebSocket relay for CCR upstreamproxy.
 *
 * Listens on localhost TCP, accepts HTTP CONNECT from curl/gh/kubectl/etc,
 * and tunnels bytes over WebSocket to the CCR upstreamproxy endpoint.
 * The CCR server-side terminates the tunnel, MITMs TLS, injects org-configured
 * credentials (e.g. DD-API-KEY), and forwards to the real upstream.
 *
 * WHY WebSocket and not raw CONNECT: CCR ingress is GKE L7 with path-prefix
 * routing; there's no connect_matcher in cdk-constructs. The session-ingress
 * tunnel (sessions/tunnel/v1alpha/tunnel.proto) already uses this pattern.
 *
 * Protocol: bytes are wrapped in UpstreamProxyChunk protobuf messages
 * (`message UpstreamProxyChunk { bytes data = 1; }`) for compatibility with
 * gateway.NewWebSocketStreamAdapter on the server side.
 */

//@C: ID=M.up.relay;K=M;V=1.0;P=Module imports and configuration;D=Networking;M=UpstreamProxy;S=WS Relay
import { createServer, type Socket as NodeSocket } from 'node:net'
import { logForDebugging } from '../utils/debug.js'
import { getWebSocketTLSOptions } from '../utils/mtls.js'
import { getWebSocketProxyAgent, getWebSocketProxyUrl } from '../utils/proxy.js'

// The CCR container runs behind an egress gateway — direct outbound is
// blocked, so the WS upgrade must go through the same HTTP CONNECT proxy
// everything else uses. undici's globalThis.WebSocket does not consult
// the global dispatcher for the upgrade, so under Node we use the ws package
// with an explicit agent (same pattern as SessionsWebSocket). Bun's native
// WebSocket takes a proxy URL directly. Preloaded in startNodeRelay so
// openTunnel stays synchronous and the CONNECT state machine doesn't race.
type WSCtor = typeof import('ws').default
let nodeWSCtor: WSCtor | undefined

// Envoy per-request buffer cap. Week-1 Datadog payloads won't hit this, but
// design for it so git-push doesn't need a relay rewrite.
const MAX_CHUNK_BYTES = 512 * 1024

// Sidecar idle timeout is 50s; ping well inside that.
const PING_INTERVAL_MS = 30_000

//@C: ID=T.up.Types;K=T;V=1.0;P=Type definitions;D=Networking;M=UpstreamProxy;S=WS Relay
// Intersection of the surface openTunnel touches. Both undici's
// globalThis.WebSocket and the ws package satisfy this via property-style
// onX handlers.
export type WebSocketLike = Pick<
  WebSocket,
  | 'onopen'
  | 'onmessage'
  | 'onerror'
  | 'onclose'
  | 'send'
  | 'close'
  | 'readyState'
  | 'binaryType'
>

export type UpstreamProxyRelay = {
  port: number
  stop: () => void
}

export type ConnState = {
  ws?: WebSocketLike
  connectBuf: Buffer
  pinger?: ReturnType<typeof setInterval>
  // Bytes that arrived after the CONNECT header but before ws.onopen fired.
  // TCP can coalesce CONNECT + ClientHello into one packet, and the socket's
  // data callback can fire again while the WS handshake is still in flight.
  // Both cases would silently drop bytes without this buffer.
  pending: Buffer[]
  wsOpen: boolean
  // Set once the server's 200 Connection Established has been forwarded and
  // the tunnel is carrying TLS. After that, writing a plaintext 502 would
  // corrupt the client's TLS stream — just close instead.
  established: boolean
  // WS onerror is always followed by onclose; without a guard the second
  // handler would sock.end() an already-ended socket. First caller wins.
  closed: boolean
}

/**
 * Minimal socket abstraction so the CONNECT parser and WS tunnel plumbing
 * are runtime-agnostic. Implementations handle write backpressure internally:
 * Bun's sock.write() does partial writes and needs explicit tail-queueing;
 * Node's net.Socket buffers unconditionally and never drops bytes.
 */
export type ClientSocket = {
  write: (data: Uint8Array | string) => void
  end: () => void
}

//@C: ID=F.up.encodeChunk;K=F;V=1.0;P=Encode UpstreamProxyChunk (protobuf wire format);D=Networking;M=UpstreamProxy;S=WS Relay;In=Uint8Array;Out=Uint8Array
/**
 * Encode an UpstreamProxyChunk protobuf message by hand.
 *
 * For `message UpstreamProxyChunk { bytes data = 1; }` the wire format is:
 *   tag = (field_number << 3) | wire_type = (1 << 3) | 2 = 0x0a
 *   followed by varint length, followed by the bytes.
 *
 * protobufjs would be the general answer; for a single-field bytes message
 * the hand encoding is 10 lines and avoids a runtime dep in the hot path.
 */
export function encodeChunk(data: Uint8Array): Uint8Array {
  console.log("F.up.encodeChunk")
  ///@C:up.varint-encode-length
  const len = data.length
  // varint encoding of length — most chunks fit in 1–3 length bytes
  const varint: number[] = []
  let n = len
  while (n > 0x7f) {
    varint.push((n & 0x7f) | 0x80)
    n >>>= 7
  }
  varint.push(n)
  ///@C:up.assemble-output
  const out = new Uint8Array(1 + varint.length + len)
  out[0] = 0x0a
  out.set(varint, 1)
  out.set(data, 1 + varint.length)
  return out
}

//@C: ID=F.up.decodeChunk;K=F;V=1.0;P=Decode UpstreamProxyChunk;D=Networking;M=UpstreamProxy;S=WS Relay;In=Uint8Array;Out=Uint8Array|null
/**
 * Decode an UpstreamProxyChunk. Returns the data field, or null if malformed.
 * Tolerates the server sending a zero-length chunk (keepalive semantics).
 */
export function decodeChunk(buf: Uint8Array): Uint8Array | null {
  console.log("F.up.decodeChunk")
  ///@C:up.validate-and-parse
  if (buf.length === 0) return new Uint8Array(0)
  if (buf[0] !== 0x0a) return null
  let len = 0
  let shift = 0
  let i = 1
  while (i < buf.length) {
    const b = buf[i]!
    len |= (b & 0x7f) << shift
    i++
    if ((b & 0x80) === 0) break
    shift += 7
    if (shift > 28) return null
  }
  if (i + len > buf.length) return null
  ///@C:up.return-slice
  return buf.subarray(i, i + len)
}

//@C: ID=F.up.newConnState;K=F;V=1.0;P=Initialize connection state;D=Networking;M=UpstreamProxy;S=WS Relay;In=void;Out=ConnState
function newConnState(): ConnState {
  console.log("F.up.newConnState")
  ///@C:up.init-state
  return {
    connectBuf: Buffer.alloc(0),
    pending: [],
    wsOpen: false,
    established: false,
    closed: false,
  }
}

//@C: ID=F.up.startUpstreamProxyRelay;K=F;V=1.0;P=Start TCP-to-WS relay (runtime-dispatch);D=Networking;M=UpstreamProxy;S=WS Relay;In={wsUrl:string,sessionId:string,token:string};Out=Promise<UpstreamProxyRelay>
/**
 * Start the relay. Returns the ephemeral port it bound and a stop function.
 * Uses Bun.listen when available, otherwise Node's net.createServer — the CCR
 * container runs the CLI under Node, not Bun.
 */
export async function startUpstreamProxyRelay(opts: {
  wsUrl: string
  sessionId: string
  token: string
}): Promise<UpstreamProxyRelay> {
  console.log("F.up.startUpstreamProxyRelay")
///@C:up.build-auth-headers
  const basicUser = process.env.UPSTREAMPROXY_BASIC_USER
  const basicPass = process.env.UPSTREAMPROXY_BASIC_PASS
  const explicitBasic =
    basicUser && basicPass
      ? 'Basic ' + Buffer.from(`${basicUser}:${basicPass}`).toString('base64')
      : undefined

  const envBearer = (process.env.UPSTREAMPROXY_WS_BEARER || '').replace(/^Bearer\s+/i, '').trim()

  const authHeader =
    explicitBasic ??
    'Basic ' + Buffer.from(`${opts.sessionId}:${opts.token}`).toString('base64')

  const wsAuthHeader = envBearer ? `Bearer ${envBearer}` : `Bearer ${opts.token}`

  ///@C:up.choose-runtime
  const relay =
    typeof Bun !== 'undefined'
      ? startBunRelay(opts.wsUrl, authHeader, wsAuthHeader)
      : await startNodeRelay(opts.wsUrl, authHeader, wsAuthHeader)

  ///@C:up.log-and-return
  logForDebugging(`[upstreamproxy] relay listening on 127.0.0.1:${relay.port}`)
  return relay
}

//@C: ID=F.up.startBunRelay;K=F;V=1.0;P=Start Bun-based TCP listener;D=Networking;M=UpstreamProxy;S=WS Relay;In=string,string,string;Out=UpstreamProxyRelay
function startBunRelay(
  wsUrl: string,
  authHeader: string,
  wsAuthHeader: string,
): UpstreamProxyRelay {
  console.log("F.up.startBunRelay")
  ///@C:up.bun-listen-setup
  // Bun TCP sockets don't auto-buffer partial writes: sock.write() returns
  // the byte count actually handed to the kernel, and the remainder is
  // silently dropped. When the kernel buffer fills, we queue the tail and
  // let the drain handler flush it. Per-socket because the adapter closure
  // outlives individual handler calls.
  type BunState = ConnState & { writeBuf: Uint8Array[] }

  // eslint-disable-next-line custom-rules/require-bun-typeof-guard -- caller dispatches on typeof Bun
  const server = Bun.listen<BunState>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(sock) {
        sock.data = { ...newConnState(), writeBuf: [] }
      },
      data(sock, data) {
        const st = sock.data
        const adapter: ClientSocket = {
          write: payload => {
            const bytes =
              typeof payload === 'string'
                ? Buffer.from(payload, 'utf8')
                : payload
            if (st.writeBuf.length > 0) {
              st.writeBuf.push(bytes)
              return
            }
            const n = sock.write(bytes)
            if (n < bytes.length) st.writeBuf.push(bytes.subarray(n))
          },
          end: () => sock.end(),
        }
        handleData(adapter, st, data, wsUrl, authHeader, wsAuthHeader)
      },
      drain(sock) {
        const st = sock.data
        while (st.writeBuf.length > 0) {
          const chunk = st.writeBuf[0]!
          const n = sock.write(chunk)
          if (n < chunk.length) {
            st.writeBuf[0] = chunk.subarray(n)
            return
          }
          st.writeBuf.shift()
        }
      },
      close(sock) {
        cleanupConn(sock.data)
      },
      error(sock, err) {
        logForDebugging(`[upstreamproxy] client socket error: ${err.message}`)
        cleanupConn(sock.data)
      },
    },
  })

  ///@C:up.return-relay
  return {
    port: server.port,
    stop: () => server.stop(true),
  }
}

//@C: ID=F.up.startNodeRelay;K=F;V=1.0;P=Start Node-based TCP listener;D=Networking;M=UpstreamProxy;S=WS Relay;In=string,string,string;Out=Promise<UpstreamProxyRelay>
// Exported so tests can exercise the Node path directly — the test runner is
// Bun, so the runtime dispatch in startUpstreamProxyRelay always picks Bun.
export async function startNodeRelay(
  wsUrl: string,
  authHeader: string,
  wsAuthHeader: string,
): Promise<UpstreamProxyRelay> {
  console.log("F.up.startNodeRelay")
  ///@C:up.import-ws
  nodeWSCtor = (await import('ws')).default
  const states = new WeakMap<NodeSocket, ConnState>()

  ///@C:up.create-server
  const server = createServer(sock => {
    const st = newConnState()
    states.set(sock, st)
    // Node's sock.write() buffers internally — a false return signals
    // backpressure but the bytes are already queued, so no tail-tracking
    // needed for correctness. Week-1 payloads won't stress the buffer.
    const adapter: ClientSocket = {
      write: payload => {
        sock.write(typeof payload === 'string' ? payload : Buffer.from(payload))
      },
      end: () => sock.end(),
    }
    sock.on('data', data =>
      handleData(adapter, st, data, wsUrl, authHeader, wsAuthHeader),
    )
    sock.on('close', () => cleanupConn(states.get(sock)))
    sock.on('error', err => {
      logForDebugging(`[upstreamproxy] client socket error: ${err.message}`)
      cleanupConn(states.get(sock))
    })
  })

  ///@C:up.listen-and-resolve
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr === null || typeof addr === 'string') {
        reject(new Error('upstreamproxy: server has no TCP address'))
        return
      }
      resolve({
        port: addr.port,
        stop: () => server.close(),
      })
    })
  })
}

//@C: ID=F.up.handleData;K=F;V=1.0;P=Per-connection data handler (CONNECT parse + WS forward);D=Networking;M=UpstreamProxy;S=WS Relay;In=ClientSocket,ConnState,Buffer,string,string,string;Out=void
/**
 * Shared per-connection data handler. Phase 1 accumulates the CONNECT request;
 * phase 2 forwards client bytes over the WS tunnel.
 */
function handleData(
  sock: ClientSocket,
  st: ConnState,
  data: Buffer,
  wsUrl: string,
  authHeader: string,
  wsAuthHeader: string,
): void {
  console.log("F.up.handleData")
  ///@C:up.phase1-accumulate
  // Phase 1: accumulate until we've seen the full CONNECT request
  // (terminated by CRLF CRLF). curl/gh send this in one packet, but
  // don't assume that.
  if (!st.ws) {
    st.connectBuf = Buffer.concat([st.connectBuf, data])
    const headerEnd = st.connectBuf.indexOf('\r\n\r\n')
    if (headerEnd === -1) {
      // Guard against a client that never sends CRLFCRLF.
      if (st.connectBuf.length > 8192) {
        sock.write('HTTP/1.1 400 Bad Request\r\n\r\n')
        sock.end()
      }
      return
    }
    const reqHead = st.connectBuf.subarray(0, headerEnd).toString('utf8')
    const firstLine = reqHead.split('\r\n')[0] ?? ''
    const m = firstLine.match(/^CONNECT\s+(\S+)\s+HTTP\/1\.[01]$/i)
    if (!m) {
      sock.write('HTTP/1.1 405 Method Not Allowed\r\n\r\n')
      sock.end()
      return
    }
    // Stash any bytes that arrived after the CONNECT header so
    // openTunnel can flush them once the WS is open.
    const trailing = st.connectBuf.subarray(headerEnd + 4)
    if (trailing.length > 0) {
      st.pending.push(Buffer.from(trailing))
    }
    st.connectBuf = Buffer.alloc(0)
    openTunnel(sock, st, firstLine, wsUrl, authHeader, wsAuthHeader)
    return
  }
  ///@C:up.phase2-forward
  // Phase 2: WS exists. If it isn't OPEN yet, buffer; ws.onopen will
  // flush. Once open, pump client bytes to WS in chunks.
  if (!st.wsOpen) {
    st.pending.push(Buffer.from(data))
    return
  }
  forwardToWs(st.ws, data)
}

//@C: ID=F.up.openTunnel;K=F;V=1.0;P=Open WS tunnel and wire event handlers;D=Networking;M=UpstreamProxy;S=WS Relay;In=ClientSocket,ConnState,string,string,string,string;Out=void
function openTunnel(
  sock: ClientSocket,
  st: ConnState,
  connectLine: string,
  wsUrl: string,
  authHeader: string,
  wsAuthHeader: string,
): void {
  console.log("F.up.openTunnel")
  ///@C:up.create-ws
  // core/websocket/stream.go picks JSON vs binary-proto from the upgrade
  // request's Content-Type header (defaults to JSON). Without application/proto
  // the server protojson.Unmarshals our hand-encoded binary chunks and fails
  // silently with EOF.
  const headers = {
    'Content-Type': 'application/proto',
    Authorization: wsAuthHeader,
  }
  let ws: WebSocketLike
  if (nodeWSCtor) {
    ws = new nodeWSCtor(wsUrl, {
      headers,
      agent: getWebSocketProxyAgent(wsUrl),
      ...getWebSocketTLSOptions(),
    }) as unknown as WebSocketLike
  } else {
    ws = new globalThis.WebSocket(wsUrl, {
      // @ts-expect-error — Bun extension; not in lib.dom WebSocket types
      headers,
      proxy: getWebSocketProxyUrl(wsUrl),
      tls: getWebSocketTLSOptions() || undefined,
    })
  }
  ws.binaryType = 'arraybuffer'
  st.ws = ws

  ///@C:up.onopen-setup
  ws.onopen = () => {
    // First chunk carries the CONNECT line plus Proxy-Authorization so the
    // server can auth the tunnel and know the target host:port. Server
    // responds with its own "HTTP/1.1 200" over the tunnel; we just pipe it.
    const head =
      `${connectLine}\r\n` + `Proxy-Authorization: ${authHeader}\r\n` + `\r\n`
    ws.send(encodeChunk(Buffer.from(head, 'utf8')))
    // Flush anything that arrived while the WS handshake was in flight —
    // trailing bytes from the CONNECT packet and any data() callbacks that
    // fired before onopen.
    st.wsOpen = true
    for (const buf of st.pending) {
      forwardToWs(ws, buf)
    }
    st.pending = []
    // Not all WS implementations expose ping(); empty chunk works as an
    // application-level keepalive the server can ignore.
    st.pinger = setInterval(sendKeepalive, PING_INTERVAL_MS, ws)
  }

  ///@C:up.onmessage-forward
  ws.onmessage = ev => {
    const raw =
      ev.data instanceof ArrayBuffer
        ? new Uint8Array(ev.data)
        : new Uint8Array(Buffer.from(ev.data))
    const payload = decodeChunk(raw)
    if (payload && payload.length > 0) {
      st.established = true
      sock.write(payload)
    }
  }

  ///@C:up.onerror-close
  ws.onerror = ev => {
    const msg = 'message' in ev ? String(ev.message) : 'websocket error'
    logForDebugging(`[upstreamproxy] ws error: ${msg}`)
    if (st.closed) return
    st.closed = true
    if (!st.established) {
      sock.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
    }
    sock.end()
    cleanupConn(st)
  }

  ///@C:up.onclose-cleanup
  ws.onclose = () => {
    if (st.closed) return
    st.closed = true
    sock.end()
    cleanupConn(st)
  }
}

//@C: ID=F.up.sendKeepalive;K=F;V=1.0;P=Send empty keepalive chunk;D=Networking;M=UpstreamProxy;S=WS Relay;In=WebSocketLike;Out=void
function sendKeepalive(ws: WebSocketLike): void {
  console.log("F.up.sendKeepalive")
  ///@C:up.send-empty-chunk
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(encodeChunk(new Uint8Array(0)))
  }
}

//@C: ID=F.up.forwardToWs;K=F;V=1.0;P=Chunk client bytes and send over WS;D=Networking;M=UpstreamProxy;S=WS Relay;In=WebSocketLike,Buffer;Out=void
function forwardToWs(ws: WebSocketLike, data: Buffer): void {
  console.log("F.up.forwardToWs")
  ///@C:up.chunk-and-send
  if (ws.readyState !== WebSocket.OPEN) return
  for (let off = 0; off < data.length; off += MAX_CHUNK_BYTES) {
    const slice = data.subarray(off, off + MAX_CHUNK_BYTES)
    ws.send(encodeChunk(slice))
  }
}

//@C: ID=F.up.cleanupConn;K=F;V=1.0;P=Cleanup connection resources;D=Networking;M=UpstreamProxy;S=WS Relay;In=ConnState|undefined;Out=void
function cleanupConn(st: ConnState | undefined): void {
  console.log("F.up.cleanupConn")
  ///@C:up.clear-intervals
  if (!st) return
  if (st.pinger) clearInterval(st.pinger)
  ///@C:up.close-ws
  if (st.ws && st.ws.readyState <= WebSocket.OPEN) {
    try {
      st.ws.close()
    } catch {
      // already closing
    }
  }
  st.ws = undefined
}
