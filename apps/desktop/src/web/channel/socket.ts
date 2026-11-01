// One channel socket through codync-web's WebSocket bridge (apps/web/internal/server/wsbridge.go).
// The browser can't set the relay's `Codync-Sig` header on a WebSocket or reach a host on the
// server's network, so the bridge opens the upstream socket and forwards the channel's JSON
// messages as they are; everything inside the channel is sealed here, in the browser.

export type Route = 'direct' | 'relay'

/** The upstream refused the socket (HTTP status, 0 when unreachable). */
export class SocketRefused extends Error {
  readonly status: number
  constructor(status: number) {
    super(status ? `refused (${status})` : 'unreachable')
    this.status = status
  }
}

export interface SocketClose {
  code: number
  reason: string
}

/** What `dial` needs to know about where it runs. */
export interface SocketEnvironment {
  /** The bridge endpoint, `wss://<this server>/bridge/ws`. */
  bridgeURL: string
  /** A WebSocket constructor (the browser's, or Node's in tests). */
  WebSocket: typeof WebSocket
}

export function browserSocketEnvironment(): SocketEnvironment {
  const base = new URL('bridge/ws', location.href)
  base.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return { bridgeURL: base.toString(), WebSocket }
}

/** Liveness per route (§7.6): direct hosts are checked through the bridge, the relay with its own ping. */
const HEARTBEAT = { direct: { every: 15_000, silence: 45_000 }, relay: { every: 30_000, silence: 75_000 } } as const
const OPEN_TIMEOUT = 15_000

export class ChannelSocket {
  readonly route: Route
  private readonly ws: WebSocket
  private onMessage: ((m: Record<string, unknown>) => void) | null = null
  private onClose: ((c: SocketClose) => void) | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private lastReceived = Date.now()
  private ended = false

  private constructor(ws: WebSocket, route: Route) {
    this.ws = ws
    this.route = route
  }

  /** Opens `target` (a `ws(s)://…/channel?v=1` or relay device URL) through the bridge. */
  static dial(env: SocketEnvironment, target: string, route: Route, signature: string | null, signal?: AbortSignal): Promise<ChannelSocket> {
    const url = new URL(env.bridgeURL)
    url.searchParams.set('url', target)
    if (signature) url.searchParams.set('sig', signature)
    return new Promise((resolve, reject) => {
      const ws = new env.WebSocket(url.toString())
      const socket = new ChannelSocket(ws, route)
      let settled = false
      const fail = (error: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        try {
          ws.close()
        } catch {}
        reject(error)
      }
      const abort = () => fail(new SocketRefused(0))
      const timer = setTimeout(abort, OPEN_TIMEOUT)
      signal?.addEventListener('abort', abort)
      if (signal?.aborted) return abort()
      ws.onmessage = (e) => {
        const m = parse(e.data)
        if (!settled) {
          if (m?.t === 'bridge.open') {
            settled = true
            clearTimeout(timer)
            signal?.removeEventListener('abort', abort)
            socket.start()
            resolve(socket)
          } else if (m?.t === 'bridge.fail') {
            fail(new SocketRefused(typeof m.status === 'number' ? m.status : 0))
          }
          return
        }
        socket.receive(m)
      }
      ws.onclose = (e) => {
        if (!settled) return fail(new SocketRefused(0))
        socket.closed({ code: e.code, reason: e.reason })
      }
      ws.onerror = () => {
        if (!settled) fail(new SocketRefused(0))
      }
    })
  }

  /** Starts delivering messages and the end; call once. */
  listen(onMessage: (m: Record<string, unknown>) => void, onClose: (c: SocketClose) => void) {
    this.onMessage = onMessage
    this.onClose = onClose
  }

  send(message: unknown) {
    if (this.ended || this.ws.readyState !== 1) return
    this.ws.send(typeof message === 'string' ? message : JSON.stringify(message))
  }

  close(code = 1000) {
    if (this.ended) return
    try {
      this.ws.close(code)
    } catch {
      this.ws.close()
    }
    // The browser reports the close later; the channel treats it as ended now.
    this.closed({ code, reason: '' })
  }

  private start() {
    const { every, silence } = HEARTBEAT[this.route]
    this.lastReceived = Date.now()
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastReceived > silence) return this.close(1011)
      // The relay's Durable Object answers this exact string with {"t":"pong"} (§7.2); the
      // bridge answers its own ping for a direct host, whose WebSocket pings it handles itself.
      this.send(this.route === 'relay' ? '{"t":"ping"}' : '{"t":"bridge.ping"}')
    }, every)
  }

  private receive(m: Record<string, unknown> | null) {
    this.lastReceived = Date.now()
    if (!m || m.t === 'pong' || m.t === 'bridge.pong') return
    this.onMessage?.(m)
  }

  private closed(c: SocketClose) {
    if (this.ended) return
    this.ended = true
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.ws.onmessage = null
    this.ws.onclose = null
    this.onClose?.(c)
  }
}

function parse(data: unknown): Record<string, unknown> | null {
  if (typeof data !== 'string') return null
  try {
    const m = JSON.parse(data) as unknown
    return m && typeof m === 'object' && !Array.isArray(m) ? (m as Record<string, unknown>) : null
  } catch {
    return null
  }
}
