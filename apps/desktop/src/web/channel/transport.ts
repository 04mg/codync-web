// The end-to-end encrypted channel to one computer (docs/reference/remote-relay.md §6, §7), ported
// from the iPhone app's ChannelTransport: the computer's direct addresses when one answers within
// 1.5 s, otherwise the cloud relay. Inner RPC multiplexes calls and streams over one channel; the
// relay adds presence and the offline mailbox. Reconnects by itself until `shutdown()`.

import { b64url, type ChannelKeys, type DeviceSigner, FrameCodec, FrameError, Handshake, IdentityChanged, offerId, sealMailbox, signRequest, unb64url } from './crypto.ts'
import { type ChannelComputer, channelURL, directURLs, isCloudURL, relayURLs } from './pairing.ts'
import { ChannelSocket, type Route, type SocketClose, SocketRefused, type SocketEnvironment } from './socket.ts'

export type LinkState =
  | { kind: 'connecting' }
  | { kind: 'ready'; route: Route }
  | { kind: 'hostOffline'; lastSeen: number | null }
  | { kind: 'unauthorized'; message: string }
  | { kind: 'failed'; message: string }

/** A failed call or stream: an HTTP-like status (0 when the link, not the request, failed). */
export class ChannelError extends Error {
  readonly status: number
  /** The relay says the computer is offline (since `lastSeen`, ms). */
  readonly offline: { lastSeen: number | null } | null
  constructor(status: number, message: string, offline: { lastSeen: number | null } | null = null) {
    super(message)
    this.status = status
    this.offline = offline
  }

  static unreachable() {
    return new ChannelError(0, "Can't reach your computer. Is it on and connected to the internet?")
  }
}

export type MailboxEvent = { kind: 'delivered' | 'expired'; nonce: string } | { kind: 'failed'; nonce: string; code: string }

export const UPGRADE_REQUIRED = 'Update Codync on your computer to keep using it from here.'

/** How one connection attempt ended. */
type Outcome =
  | { kind: 'again' }
  | { kind: 'retry'; message: string }
  | { kind: 'wait'; state: LinkState }
  | { kind: 'stop'; state: LinkState }

interface Link {
  socket: ChannelSocket
  route: Route
  handshake: Handshake | null
  codec: FrameCodec | null
  end: (o: Outcome) => void
}

interface PendingCall {
  resolve: (v: unknown) => void
  reject: (e: ChannelError) => void
  timer: ReturnType<typeof setTimeout>
}

interface Stream {
  onEvent: (ev: unknown) => void
  onEnd: (error: ChannelError | null) => void
}

const DIRECT_BUDGET = 1500
const HANDSHAKE_TIMEOUT = 10_000
const MAX_CALLS = 32
const MAX_STREAMS = 4
const MAX_MESSAGE = 16 * 1024 * 1024

export interface ChannelOptions {
  computer: ChannelComputer
  /** The device key, or its loading (IndexedDB); a failure to load stops the channel with its message. */
  device: DeviceSigner | Promise<DeviceSigner>
  env: SocketEnvironment
  /** Pairing mode (§4.1): the only request is `pair`; the host then closes with 4100. */
  pairingCode?: string | null
  /** Whether pairing links and hellos may name a development cloud on http://127.0.0.1. */
  allowLocalCloud?: boolean
}

export class ChannelTransport {
  computer: ChannelComputer
  state: LinkState = { kind: 'connecting' }
  /** Gave up for good (revoked, identity changed, needs an update): only a new transport recovers. */
  stopped = false

  private readonly loadingDevice: Promise<DeviceSigner>
  private device!: DeviceSigner
  private readonly env: SocketEnvironment
  private readonly pairingCode: string | null
  private readonly allowLocalCloud: boolean
  private link: Link | null = null
  private closed = false
  private wakeUp: (() => void) | null = null
  private restartRequested = false
  /** Relay upgrades refused with 403 since the last handshake (the ACL may lag a fresh pairing). */
  private refusals = 0
  private nextId = 0
  private readonly calls = new Map<number, PendingCall>()
  private readonly streams = new Map<number, Stream>()
  private readonly mailboxWaits = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private readonly stateListeners = new Set<(s: LinkState) => void>()
  private readonly computerListeners = new Set<(c: ChannelComputer) => void>()
  private readonly mailboxListeners = new Set<(e: MailboxEvent) => void>()

  constructor(o: ChannelOptions) {
    this.computer = o.computer
    this.loadingDevice = Promise.resolve(o.device)
    this.env = o.env
    this.pairingCode = o.pairingCode ?? null
    this.allowLocalCloud = o.allowLocalCloud ?? false
  }

  start() {
    void this.run()
    return this
  }

  shutdown() {
    if (this.closed) return
    this.closed = true
    this.link?.socket.close(1000)
    this.dropChannel(ChannelError.unreachable())
    this.wake()
    this.stateListeners.clear()
    this.computerListeners.clear()
    this.mailboxListeners.clear()
  }

  /** Reconnects from scratch (the tab came back, the network changed). */
  reconnect() {
    if (this.closed || this.stopped) return
    this.restartRequested = true
    this.link?.socket.close(1000)
    this.wake()
  }

  onState(cb: (s: LinkState) => void) {
    this.stateListeners.add(cb)
    return () => void this.stateListeners.delete(cb)
  }

  /** Every merged computer after an inner `hello` (§7.5 step 5); persist it. */
  onComputer(cb: (c: ChannelComputer) => void) {
    this.computerListeners.add(cb)
    return () => void this.computerListeners.delete(cb)
  }

  onMailbox(cb: (e: MailboxEvent) => void) {
    this.mailboxListeners.add(cb)
    return () => void this.mailboxListeners.delete(cb)
  }

  get route(): Route | null {
    return this.state.kind === 'ready' ? this.state.route : null
  }

  // MARK: connection loop (§7.5, §7.6)

  private async run() {
    try {
      this.device = await this.loadingDevice
    } catch (error) {
      this.stopped = true
      this.setState({ kind: 'failed', message: error instanceof Error ? error.message : String(error) })
      return
    }
    let attempt = 0
    while (!this.closed) {
      if (this.state.kind === 'ready') this.setState({ kind: 'connecting' })
      const started = Date.now()
      const outcome = await this.attempt()
      if (this.closed) return
      if (this.restartRequested) {
        this.restartRequested = false
        attempt = 0
        continue
      }
      if (outcome.kind === 'again') {
        attempt = 0
        continue
      }
      if (outcome.kind === 'stop') {
        this.stopped = true
        this.setState(outcome.state)
        return
      }
      // Stable for a minute: the next failure starts the backoff over.
      if (Date.now() - started > 60_000) attempt = 0
      if (outcome.kind === 'wait') this.setState(outcome.state)
      else if (this.state.kind !== 'hostOffline') this.setState({ kind: 'failed', message: outcome.message })
      // From 1 s doubling to 30 s, full jitter.
      const delay = Math.random() * Math.min(30_000, 1000 * 2 ** attempt++)
      await this.sleep(delay)
      this.restartRequested = false
    }
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms)
      function done() {
        clearTimeout(timer)
        resolve()
      }
      this.wakeUp = done
    })
  }

  private wake() {
    const w = this.wakeUp
    this.wakeUp = null
    w?.()
  }

  private async attempt(): Promise<Outcome> {
    const direct = this.computer.urls.map(channelURL).filter((u): u is string => !!u)
    if (direct.length) {
      const raced = await this.raceDirect(direct)
      if (raced.kind === 'connected') return this.serve(raced.socket, 'direct', raced.keys)
      if (raced.kind === 'identityChanged') return { kind: 'stop', state: { kind: 'unauthorized', message: new IdentityChanged().message } }
      if (raced.kind === 'rejected' && !this.computer.cloud) {
        // A plaintext `reject` isn't signed: anything at a saved address can send one. Only a
        // pairing (short-lived, user-driven) ends on it; a saved computer keeps retrying.
        if (this.pairingCode) return raced.outcome
        return raced.outcome.kind === 'stop' ? { kind: 'wait', state: raced.outcome.state } : raced.outcome
      }
    }
    const cloud = this.computer.cloud
    if (!cloud) return { kind: 'retry', message: ChannelError.unreachable().message }
    const { signed, dial } = relayURLs(cloud, this.computer.id, this.pairingCode ? offerId(unb64url(this.pairingCode)) : null)
    let socket: ChannelSocket
    try {
      socket = await ChannelSocket.dial(this.env, dial, 'relay', await signRequest(this.device, 'GET', signed))
    } catch (error) {
      return this.refused(error)
    }
    return this.serve(socket, 'relay', null)
  }

  private refused(error: unknown): Outcome {
    const status = error instanceof SocketRefused ? error.status : 0
    if (status === 403) {
      this.refusals++
      return this.refusals <= 3
        ? { kind: 'retry', message: ChannelError.unreachable().message }
        : { kind: 'stop', state: { kind: 'unauthorized', message: `This device isn't allowed on ${this.computer.name} anymore.` } }
    }
    if (status === 426) return { kind: 'stop', state: { kind: 'failed', message: UPGRADE_REQUIRED } }
    if (status === 404) return { kind: 'retry', message: `${this.computer.name} hasn't connected to the relay yet.` }
    return { kind: 'retry', message: ChannelError.unreachable().message }
  }

  /** Every direct candidate in parallel; the first finished handshake within the budget wins. */
  private async raceDirect(urls: string[]): Promise<
    | { kind: 'connected'; socket: ChannelSocket; keys: ChannelKeys }
    | { kind: 'identityChanged' }
    | { kind: 'rejected'; outcome: Outcome }
    | { kind: 'none' }
  > {
    const abort = new AbortController()
    let rejection: Outcome | null = null
    const attempts = urls.map(async (url) => {
      const r = await this.directHandshake(url, abort.signal)
      if (r.kind === 'rejected') rejection ??= r.outcome
      if (r.kind === 'connected' || r.kind === 'identityChanged') return r
      throw new Error('no')
    })
    const budget = new Promise<null>((resolve) => setTimeout(() => resolve(null), DIRECT_BUDGET))
    const winner = await Promise.race([Promise.any(attempts).catch(() => null), budget])
    abort.abort()
    // A slower address that connected anyway: not needed.
    for (const a of attempts) void a.then((r) => r !== winner && r.kind === 'connected' && r.socket.close(1000), () => {})
    if (winner) return winner
    return rejection ? { kind: 'rejected', outcome: rejection } : { kind: 'none' }
  }

  private async directHandshake(url: string, signal: AbortSignal): Promise<
    | { kind: 'connected'; socket: ChannelSocket; keys: ChannelKeys }
    | { kind: 'identityChanged' }
    | { kind: 'rejected'; outcome: Outcome }
    | { kind: 'none' }
  > {
    let socket: ChannelSocket
    try {
      socket = await ChannelSocket.dial(this.env, url, 'direct', null, signal)
    } catch {
      return { kind: 'none' }
    }
    const hs = new Handshake(this.device, unb64url(this.computer.signKey))
    return new Promise((resolve) => {
      const finish = (r: Awaited<ReturnType<ChannelTransport['directHandshake']>>, close?: number) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', aborted)
        if (close !== undefined) socket.close(close)
        resolve(r)
      }
      const aborted = () => finish({ kind: 'none' }, 1000)
      const timer = setTimeout(aborted, HANDSHAKE_TIMEOUT)
      signal.addEventListener('abort', aborted)
      socket.listen((m) => {
        if (m.t === 'welcome') {
          try {
            finish({ kind: 'connected', socket, keys: hs.finish(m) })
          } catch (error) {
            finish(error instanceof IdentityChanged ? { kind: 'identityChanged' } : { kind: 'none' }, error instanceof IdentityChanged ? 4001 : 4002)
          }
        } else if (m.t === 'reject') {
          const outcome = this.rejection(m)
          finish(outcome ? { kind: 'rejected', outcome } : { kind: 'none' }, 1000)
        }
      }, () => finish({ kind: 'none' }))
      void hs.hello(!!this.pairingCode).then((hello) => socket.send(hello), () => finish({ kind: 'none' }, 1000))
    })
  }

  /** What a `reject` means, or null when a plain retry may succeed (rate limits, clock skew). */
  private rejection(m: Record<string, unknown>): Outcome | null {
    const message = typeof m.message === 'string' && m.message ? m.message : null
    switch (m.code) {
      case 'unauthorized':
      case 'revoked':
        return { kind: 'stop', state: { kind: 'unauthorized', message: message ?? "This device isn't allowed on that computer anymore." } }
      case 'leaseExpired':
        // The computer couldn't confirm the account's approval lately; it may again.
        return { kind: 'wait', state: { kind: 'failed', message: message ?? "Your computer couldn't confirm this device's access. Retrying." } }
      case 'unsupportedVersion':
        return { kind: 'stop', state: { kind: 'failed', message: UPGRADE_REQUIRED } }
      case 'pairingClosed':
        return { kind: 'stop', state: { kind: 'failed', message: message ?? 'This pairing code expired. Show a new one on the computer.' } }
      default:
        return null
    }
  }

  /** Runs one socket until it ends. */
  private serve(socket: ChannelSocket, route: Route, keys: ChannelKeys | null): Promise<Outcome> {
    return new Promise((resolve) => {
      let ended = false
      const link: Link = {
        socket, route, handshake: null, codec: null,
        end: (o) => {
          if (ended) return
          ended = true
          if (this.link === link) this.link = null
          this.dropChannel(this.state.kind === 'hostOffline' ? new ChannelError(0, 'Your computer is offline.', { lastSeen: this.state.lastSeen }) : ChannelError.unreachable())
          this.failMailbox()
          resolve(o)
        },
      }
      this.link = link
      socket.listen(
        (m) => {
          const outcome = this.handle(link, m)
          if (outcome) {
            socket.close(1000)
            link.end(outcome)
          }
        },
        (c) => link.end(this.closeOutcome(c)),
      )
      if (keys) this.install(link, keys)
      if (this.closed || this.restartRequested) socket.close(1000)
    })
  }

  private closeOutcome(c: SocketClose): Outcome {
    switch (c.code) {
      case 4001:
      case 4003:
        return { kind: 'stop', state: { kind: 'unauthorized', message: `This device isn't allowed on ${this.computer.name} anymore.` } }
      case 4410:
        return { kind: 'stop', state: { kind: 'failed', message: 'This pairing code expired. Show a new one on the computer.' } }
      case 4400:
        return { kind: 'stop', state: { kind: 'failed', message: UPGRADE_REQUIRED } }
      case 4100:
        // Paired: pairing mode is done; otherwise reconnect normally.
        return this.pairingCode ? { kind: 'stop', state: { kind: 'failed', message: 'Paired.' } } : { kind: 'again' }
      case 4011:
        return { kind: 'again' }
      default:
        return { kind: 'retry', message: ChannelError.unreachable().message }
    }
  }

  // MARK: incoming

  private handle(link: Link, m: Record<string, unknown>): Outcome | null {
    if (this.link !== link) return null
    switch (m.t) {
      case 'presence':
        if (m.online === true) {
          // The host (re)joined: any previous channel is gone; start a fresh handshake.
          this.dropChannel(ChannelError.unreachable())
          return this.startHandshake(link)
        }
        link.handshake = null
        link.codec = null
        this.dropChannel(new ChannelError(0, 'Your computer is offline.', { lastSeen: typeof m.lastSeenAt === 'number' ? m.lastSeenAt : null }))
        this.setState({ kind: 'hostOffline', lastSeen: typeof m.lastSeenAt === 'number' ? m.lastSeenAt : null })
        return null
      case 'welcome': {
        const hs = link.handshake
        if (!hs) return { kind: 'retry', message: ChannelError.unreachable().message }
        link.handshake = null
        try {
          this.install(link, hs.finish(m))
        } catch (error) {
          return error instanceof IdentityChanged
            ? { kind: 'stop', state: { kind: 'unauthorized', message: error.message } }
            : { kind: 'retry', message: 'Protocol error' }
        }
        return null
      }
      case 'reject':
        return this.rejection(m) ?? { kind: 'retry', message: typeof m.message === 'string' ? m.message : ChannelError.unreachable().message }
      case 'f': {
        if (!link.codec) {
          link.socket.close(4002)
          return { kind: 'retry', message: 'Protocol error' }
        }
        try {
          const message = link.codec.open(m)
          if (message !== undefined) this.handleInner(message)
        } catch (error) {
          link.socket.close(error instanceof FrameError ? error.closeCode : 4002)
          return { kind: 'retry', message: 'Protocol error' }
        }
        return null
      }
      default:
        if (typeof m.t === 'string' && m.t.startsWith('mbox.')) this.handleMailbox(m)
        return null
    }
  }

  private startHandshake(link: Link): Outcome | null {
    const hs = new Handshake(this.device, unb64url(this.computer.signKey))
    link.handshake = hs
    link.codec = null
    if (this.state.kind === 'ready' || this.state.kind === 'hostOffline') this.setState({ kind: 'connecting' })
    void hs.hello(!!this.pairingCode).then((hello) => {
      if (link.handshake === hs) link.socket.send(hello)
    }, () => link.socket.close(1000))
    // No welcome within 10 s: give up on this socket.
    setTimeout(() => {
      if (this.link === link && link.handshake === hs) link.socket.close(1000)
    }, HANDSHAKE_TIMEOUT)
    return null
  }

  private install(link: Link, keys: ChannelKeys) {
    link.codec = new FrameCodec(keys, MAX_MESSAGE)
    this.refusals = 0
    this.setState({ kind: 'ready', route: link.route })
    if (!this.pairingCode) void this.refreshComputer()
  }

  /** Inner RPC (§6.5): `ok`/`err` answer calls, `ev`/`end`/`err` feed streams. */
  private handleInner(message: unknown) {
    if (!message || typeof message !== 'object') return
    const m = message as Record<string, unknown>
    const id = m.id
    if (typeof id !== 'number') return
    if ('ev' in m) {
      this.streams.get(id)?.onEvent(m.ev)
    } else if (m.end === true) {
      this.finishStream(id, null)
    } else if (m.err && typeof m.err === 'object') {
      const err = m.err as { status?: unknown; message?: unknown }
      const status = typeof err.status === 'number' ? err.status : 500
      const error = new ChannelError(status, typeof err.message === 'string' ? err.message : `Host error ${status}`)
      const call = this.calls.get(id)
      if (call) {
        this.calls.delete(id)
        clearTimeout(call.timer)
        call.reject(error)
      } else {
        this.finishStream(id, error)
      }
    } else if ('ok' in m) {
      const call = this.calls.get(id)
      if (!call) return
      this.calls.delete(id)
      clearTimeout(call.timer)
      call.resolve(m.ok)
    }
  }

  /** Ends everything riding on the channel (not the mailbox, which lives on the relay socket). */
  private dropChannel(error: ChannelError) {
    const calls = [...this.calls.values()]
    const streams = [...this.streams.values()]
    this.calls.clear()
    this.streams.clear()
    for (const c of calls) {
      clearTimeout(c.timer)
      c.reject(error)
    }
    // Route change or re-handshake: the store resubscribes from its own rev.
    for (const s of streams) s.onEnd(error)
  }

  // MARK: inner hello (§7.5 step 5)

  private async refreshComputer() {
    let hello: Record<string, unknown>
    try {
      hello = (await this.call('hello', null, 20_000)) as Record<string, unknown>
    } catch {
      return
    }
    this.merge(hello)
  }

  merge(hello: Record<string, unknown>) {
    // The welcome signature already proved the key; a hello naming another computer is ignored.
    if ((hello.computerId != null && hello.computerId !== this.computer.id) || (hello.signKey != null && hello.signKey !== this.computer.signKey)) return
    const c: ChannelComputer = { ...this.computer }
    if (typeof hello.name === 'string' && hello.name) c.name = hello.name
    if (typeof hello.boxKey === 'string') {
      try {
        if (unb64url(hello.boxKey).length === 32) c.boxKey = hello.boxKey
      } catch {}
    }
    if (Array.isArray(hello.urls)) c.urls = directURLs(hello.urls)
    c.cloud = typeof hello.cloud === 'string' && isCloudURL(hello.cloud, this.allowLocalCloud) ? hello.cloud.replace(/\/+$/, '') : null
    if (typeof hello.device === 'string') c.device = hello.device
    if (JSON.stringify(c) === JSON.stringify(this.computer)) return
    this.computer = c
    for (const l of this.computerListeners) l(c)
  }

  // MARK: calls and streams

  /** Waits (bounded) while connecting; throws what the link state means otherwise. */
  async ready(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (this.closed) throw ChannelError.unreachable()
      const s = this.state
      if (s.kind === 'ready' && this.link?.codec) return
      if (s.kind === 'hostOffline') throw new ChannelError(0, 'Your computer is offline.', { lastSeen: s.lastSeen })
      if (s.kind === 'unauthorized') throw new ChannelError(401, s.message)
      if (s.kind === 'failed' && this.stopped) throw new ChannelError(s.message === UPGRADE_REQUIRED ? 426 : 0, s.message)
      const left = deadline - Date.now()
      if (left <= 0) throw ChannelError.unreachable()
      await new Promise<void>((resolve) => {
        const off = this.onState(() => {
          off()
          clearTimeout(timer)
          resolve()
        })
        const timer = setTimeout(() => {
          off()
          resolve()
        }, Math.min(left, 1000))
      })
    }
  }

  private allocateId() {
    this.nextId = this.nextId >= 0xffffffff ? 1 : this.nextId + 1
    return this.nextId
  }

  async call(method: string, body: unknown, timeoutMs = 20_000): Promise<unknown> {
    await this.ready(timeoutMs)
    if (this.calls.size >= MAX_CALLS) throw new ChannelError(429, 'Too many requests at once.')
    const id = this.allocateId()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.calls.delete(id)) return
        // Timed out: the host drops the answer (an already started mutation still runs).
        this.sendInner({ id, cancel: true })
        reject(ChannelError.unreachable())
      }, timeoutMs)
      this.calls.set(id, { resolve, reject, timer })
      if (!this.sendInner({ id, m: method, b: body ?? null })) {
        this.calls.delete(id)
        clearTimeout(timer)
        reject(ChannelError.unreachable())
      }
    })
  }

  /** A subscription (§6.5): `events`, `term` or `screenCandidates`. Returns its cancel. */
  subscribe(sub: 'events' | 'term' | 'screenCandidates', body: unknown, onEvent: (ev: unknown) => void, onEnd: (error: ChannelError | null) => void): () => void {
    let id: number | null = null
    let cancelled = false
    void (async () => {
      try {
        await this.ready(10_000)
      } catch (error) {
        if (!cancelled) onEnd(error instanceof ChannelError ? error : ChannelError.unreachable())
        return
      }
      if (cancelled) return
      if (this.streams.size >= MAX_STREAMS) return onEnd(new ChannelError(429, 'Too many streams at once.'))
      id = this.allocateId()
      this.streams.set(id, { onEvent, onEnd })
      if (!this.sendInner({ id, sub, b: body })) this.finishStream(id, ChannelError.unreachable())
    })()
    return () => {
      cancelled = true
      if (id !== null && this.streams.delete(id)) this.sendInner({ id, cancel: true })
    }
  }

  private finishStream(id: number, error: ChannelError | null) {
    const s = this.streams.get(id)
    if (!s) return
    this.streams.delete(id)
    s.onEnd(error)
  }

  private sendInner(message: unknown): boolean {
    const link = this.link
    if (!link?.codec) return false
    for (const frame of link.codec.seal(message)) link.socket.send(frame)
    // Counters must never wrap: replace the channel (§3.5).
    if (link.codec.exhausted) {
      this.restartRequested = true
      link.socket.close(4011)
    }
    return true
  }

  // MARK: mailbox (§6.4, §7.4)

  /** Whether a message can wait in the relay for this computer: it's offline and its box key is pinned. */
  get canQueue() {
    return this.state.kind === 'hostOffline' && this.link?.route === 'relay' && !!this.computer.boxKey && !this.pairingCode
  }

  /** Seals a `send` and leaves it in the relay's mailbox until the computer comes back. */
  async queueSend(body: { botId: string; text: string; clientNonce: string }): Promise<void> {
    const link = this.link
    if (!this.canQueue || !link || !this.computer.boxKey) throw new ChannelError(0, 'Your computer is offline.')
    const inner = JSON.stringify({ m: 'send', b: body, ts: Date.now() })
    const blob = await sealMailbox(this.device, unb64url(this.computer.signKey), unb64url(this.computer.boxKey), body.clientNonce, inner)
    const done = new Promise((resolve, reject) => this.mailboxWaits.set(body.clientNonce, { resolve, reject }))
    link.socket.send({ t: 'mbox.put', nonce: body.clientNonce, d: b64url(blob) })
    await done
  }

  private handleMailbox(m: Record<string, unknown>) {
    const nonce = typeof m.nonce === 'string' ? m.nonce : null
    if (!nonce) return
    const wait = this.mailboxWaits.get(nonce)
    switch (m.t) {
      case 'mbox.ok':
        this.mailboxWaits.delete(nonce)
        wait?.resolve(undefined)
        break
      case 'mbox.err':
        this.mailboxWaits.delete(nonce)
        wait?.reject(new ChannelError(m.code === 'hostOnline' ? 0 : 400, m.code === 'hostOnline' ? 'Your computer is back online. Send again.' : `The relay couldn't keep the message (${String(m.code)}).`))
        break
      case 'mbox.delivered':
      case 'mbox.expired':
        for (const l of this.mailboxListeners) l({ kind: m.t === 'mbox.delivered' ? 'delivered' : 'expired', nonce })
        break
      case 'mbox.failed':
        for (const l of this.mailboxListeners) l({ kind: 'failed', nonce, code: typeof m.code === 'string' ? m.code : 'invalid' })
        break
    }
  }

  private failMailbox() {
    const waits = [...this.mailboxWaits.values()]
    this.mailboxWaits.clear()
    for (const w of waits) w.reject(ChannelError.unreachable())
  }

  // MARK: state

  private setState(next: LinkState) {
    if (JSON.stringify(next) === JSON.stringify(this.state)) return
    this.state = next
    for (const l of [...this.stateListeners]) l(next)
  }
}
