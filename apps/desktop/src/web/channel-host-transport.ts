// The renderer's `HostTransport` over the end-to-end encrypted channel: `POST /api/<method>` becomes
// an inner request and `GET /events` / `GET /term/<id>` become subscriptions (§6.5), with the same
// JSON bodies and events, so the stores and views work unchanged.

import { HostError, type HostRoute, type HostTransport } from '../renderer/client/host-client'
import { ChannelError, type ChannelTransport } from './channel/transport'

export function hostError(error: unknown): HostError {
  if (error instanceof HostError) return error
  if (error instanceof ChannelError) return new HostError(error.status, error.message, error.offline)
  return new HostError(0, error instanceof Error ? error.message : String(error))
}

export class ChannelHostTransport implements HostTransport {
  constructor(private readonly channel: ChannelTransport) {}

  async call(method: string, body: unknown, timeoutMs: number): Promise<unknown> {
    try {
      return await this.channel.call(method, body, timeoutMs)
    } catch (error) {
      throw hostError(error)
    }
  }

  stream(path: string, onData: (line: string) => void, onEnd: (error: HostError | null) => void): () => void {
    const url = new URL(path, 'https://host.invalid')
    const term = /^\/term\/(.+)$/.exec(url.pathname)
    let sub: { kind: 'events' | 'term'; body: unknown }
    if (url.pathname === '/events') {
      sub = { kind: 'events', body: { since: Number(url.searchParams.get('since') ?? 0), client: url.searchParams.get('client') ?? 'desktop' } }
    } else if (term) {
      sub = { kind: 'term', body: { term: decodeURIComponent(term[1]!) } }
    } else {
      queueMicrotask(() => onEnd(new HostError(404, `No stream at ${url.pathname}`)))
      return () => {}
    }
    return this.channel.subscribe(sub.kind, sub.body, (ev) => onData(JSON.stringify(ev)), (error) => onEnd(error ? hostError(error) : null))
  }

  route(): HostRoute | null {
    return this.channel.route
  }

  canQueue() {
    return this.channel.canQueue
  }

  async queueSend(body: { botId: string; text: string; clientNonce: string }) {
    try {
      await this.channel.queueSend(body)
    } catch (error) {
      throw hostError(error)
    }
  }
}
