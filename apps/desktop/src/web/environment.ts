// What the web client knows about where it runs: the codync-web server's settings (`/auth/session`),
// the bridge endpoint for channel sockets, and this browser's name as a computer lists it.

import { browserSocketEnvironment, type SocketEnvironment } from './channel/socket'

export interface WebConfig {
  version: string
  /** A development cloud on http://127.0.0.1 is allowed (codync-web --allow-local-cloud). */
  allowLocalCloud: boolean
  /** The Codync cloud for accounts (`--cloud-url`); null turns account sign-in off. */
  cloudURL: string | null
  /** The account provider's publishable key (`--clerk-key`). */
  clerkPublishableKey: string | null
  /** Sign-in to this server is on (`--no-auth` turns it off). */
  signInRequired: boolean
}

let config: WebConfig | null = null

/** Reads the server's settings once, before the app starts. */
export async function loadWebConfig(): Promise<WebConfig> {
  const res = await fetch('auth/session', { cache: 'no-store' })
  const body = (await res.json()) as Partial<WebConfig> & { signedIn?: boolean; required?: boolean }
  if (body.required && !body.signedIn) {
    // The session ended: the server shows its sign-in page.
    location.reload()
    await new Promise(() => {})
  }
  config = {
    version: body.version ?? 'dev',
    allowLocalCloud: body.allowLocalCloud === true,
    cloudURL: typeof body.cloudURL === 'string' && body.cloudURL ? body.cloudURL : null,
    clerkPublishableKey: typeof body.clerkPublishableKey === 'string' && body.clerkPublishableKey ? body.clerkPublishableKey : null,
    signInRequired: body.required === true,
  }
  return config
}

export function webConfig(): WebConfig {
  if (!config) throw new Error('The web client started before its settings loaded.')
  return config
}

let sessionCheck: Promise<void> | null = null

/** After a bridge socket fails: if the session to this server ended, go back to its sign-in page. */
function checkSession() {
  sessionCheck ??= (async () => {
    try {
      const res = await fetch('auth/session', { cache: 'no-store' })
      const body = (await res.json()) as { signedIn?: boolean; required?: boolean }
      if (body.required && !body.signedIn) location.reload()
    } catch {
      // The server itself is unreachable: the computers show it as offline.
    } finally {
      setTimeout(() => (sessionCheck = null), 30_000)
    }
  })()
}

let environment: SocketEnvironment | null = null

export function socketEnvironment(): SocketEnvironment {
  if (environment) return environment
  const base = browserSocketEnvironment()
  // A WebSocket that never opens may mean the session to this server expired.
  const Watched = function (url: string | URL) {
    const ws = new WebSocket(url)
    ws.addEventListener('close', (e) => {
      if (e.code === 1006) checkSession()
    })
    return ws
  } as unknown as typeof WebSocket
  environment = { ...base, WebSocket: Watched }
  return environment
}

/** This server as a computer lists its devices (every browser on it is that one device): "Codync Web · codync.example.com". */
export function deviceName(): string {
  return `Codync Web · ${location.hostname}`
}

/** The browser's operating system, for the keyboard (⌘ on a Mac, Ctrl elsewhere). */
export const isMacBrowser = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
