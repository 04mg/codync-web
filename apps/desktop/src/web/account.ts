// The Codync account in the browser, through Clerk's Frontend API the way the desktop app drives it
// (apps/desktop/src/main/account.ts): a client token in the `Authorization` header (`_is_native`).
// A browser on a self-hosted address can't receive the apps' sign-in redirect, so it signs in with a
// code sent to the account's email instead. Neither the account nor the cloud ever grants access to
// a computer by itself (spec §4.2): each computer still approves this browser.
//
// Every request goes through codync-web's `/v1` proxy (the cloud and Clerk send no CORS headers for
// this origin); requests to the cloud are signed here with this browser's device key for the account.

import type { AccountState, EmailSignInBridge } from '@shared/ipc'
import type { SignInFailure } from '@shared/analytics'
import { sha256 } from '@noble/hashes/sha2.js'
import { b64url, signRequest, utf8Encoder } from './channel/crypto'
import { deviceKey } from './channel/device-key'
import { webConfig } from './environment'

const TOKEN_KEY = 'codync-web-clerk-client'

interface ProxyAnswer {
  status: number
  headers: Record<string, string>
  body: Uint8Array
}

function toBase64(bytes: Uint8Array) {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

/** One request through codync-web's cloud proxy. */
export async function viaProxy(method: string, url: URL, headers: Record<string, string>, body: Uint8Array | null): Promise<ProxyAnswer> {
  const res = await fetch('bridge/http', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, url: url.toString(), headers, body: body ? toBase64(body) : '' }),
  })
  if (res.status === 401) {
    location.reload()
    throw new Error('Sign in to this server again.')
  }
  if (!res.ok) throw new Error(`The server refused the request (${res.status}).`)
  const answer = (await res.json()) as { status: number; headers?: Record<string, string>; body?: string }
  return { status: answer.status, headers: answer.headers ?? {}, body: Uint8Array.from(atob(answer.body ?? ''), (c) => c.charCodeAt(0)) }
}

/** The device-key context of an account (§3.2): one key per account, never the pairing key. */
export const accountContext = (userId: string) => `account:${b64url(sha256(utf8Encoder.encode(userId)).subarray(0, 12))}`

interface ClerkUser {
  id: string
  image_url?: string
  primary_email_address_id?: string | null
  email_addresses?: { id: string; email_address: string }[]
}
interface ClerkSession {
  id: string
  status: string
  user?: ClerkUser
}
interface ClerkClient {
  sessions?: ClerkSession[]
  last_active_session_id?: string | null
}
interface SignIn {
  id: string
  status: string
  supported_first_factors?: { strategy: string; email_address_id?: string }[] | null
}

class ClerkError extends Error {
  readonly status: number
  readonly code: string | undefined
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export class WebAccount {
  state: AccountState
  private readonly listeners = new Set<(s: AccountState) => void>()
  private readonly frontendAPI: string | null
  private token: string | null = null
  private client: ClerkClient | null = null
  private cachedJWT: { session: string; jwt: string; until: number } | null = null
  private signIn: SignIn | null = null
  /** Signed out of an account: its computers go too (remote-computers.ts). */
  onSignedOut: ((context: string) => void) | null = null

  constructor() {
    const { cloudURL, clerkPublishableKey } = webConfig()
    this.frontendAPI = clerkPublishableKey ? frontendAPI(clerkPublishableKey) : null
    this.state = { ready: !this.frontendAPI, configured: !!this.frontendAPI && !!cloudURL, busy: false, error: null, user: null, cloudURL }
    try {
      this.token = localStorage.getItem(TOKEN_KEY)
    } catch {}
    void this.restore()
  }

  onChange(cb: (s: AccountState) => void) {
    this.listeners.add(cb)
    return () => void this.listeners.delete(cb)
  }

  private set(change: Partial<AccountState>) {
    this.state = { ...this.state, ...change }
    for (const l of this.listeners) l(this.state)
  }

  private async restore() {
    if (!this.frontendAPI) return
    try {
      if (this.token) await this.refreshClient()
    } catch {
      // Offline: the saved session still counts; the next call refreshes it.
    }
    this.set({ ready: true })
  }

  private persist() {
    try {
      if (this.token) localStorage.setItem(TOKEN_KEY, this.token)
      else localStorage.removeItem(TOKEN_KEY)
    } catch {}
  }

  private async request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, form?: Record<string, string>): Promise<T> {
    if (!this.frontendAPI) throw new ClerkError(0, "Sign-in isn't set up on this server.")
    const url = new URL(`${this.frontendAPI}${path}`)
    url.searchParams.set('_is_native', 'true')
    const headers: Record<string, string> = { 'x-device-type': 'web', 'x-app-version': window.codync.appVersion }
    if (this.token) headers.Authorization = this.token
    let body: Uint8Array | null = null
    if (form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
      body = utf8Encoder.encode(new URLSearchParams(form).toString())
    }
    const res = await viaProxy(method, url, headers, body)
    if (res.status === 0) throw new ClerkError(0, "Can't reach the account service. Check the connection.")
    // The client token rotates with responses (sign-in, sign-out).
    const auth = res.headers.authorization
    if (auth !== undefined) {
      this.token = !auth || auth.toLowerCase() === 'bearer' ? null : auth
      this.persist()
    }
    let json: { response?: T; client?: ClerkClient | null; errors?: { code?: string; long_message?: string; message?: string }[] } & T
    try {
      json = JSON.parse(new TextDecoder().decode(res.body))
    } catch {
      throw new ClerkError(res.status, `Account service error ${res.status}`)
    }
    if (res.status >= 400) throw new ClerkError(res.status, json.errors?.[0]?.long_message ?? json.errors?.[0]?.message ?? `Account service error ${res.status}`, json.errors?.[0]?.code)
    if ('client' in json) this.applyClient(json.client ?? null)
    return (json.response ?? json) as T
  }

  private applyClient(client: ClerkClient | null) {
    const before = this.state.user?.userId ?? null
    this.client = client
    const session = this.activeSession
    const user = session?.user
    const email = user?.email_addresses?.find((e) => e.id === user.primary_email_address_id)?.email_address ?? user?.email_addresses?.[0]?.email_address ?? null
    const image = user?.image_url?.startsWith('https://') ? user.image_url : null
    this.set({ user: user ? { userId: user.id, email, avatarURL: image } : null })
    if (before && before !== (user?.id ?? null)) this.onSignedOut?.(accountContext(before))
  }

  private get activeSession(): ClerkSession | null {
    return this.client?.sessions?.find((s) => s.id === this.client?.last_active_session_id && s.status === 'active') ?? null
  }

  private async refreshClient() {
    this.applyClient(await this.request<ClerkClient | null>('GET', '/v1/client'))
  }

  /** Apple or Google sign-in needs the apps' redirect: the browser offers the emailed code instead. */
  async signInWithProvider(): Promise<SignInFailure | null> {
    this.set({ error: 'Sign in with the code we email you.' })
    return 'error'
  }

  readonly email: EmailSignInBridge = {
    start: async (email: string) => {
      this.set({ busy: true, error: null })
      try {
        const created = await this.request<SignIn>('POST', '/v1/client/sign_ins', { identifier: email.trim() })
        const factor = created.supported_first_factors?.find((f) => f.strategy === 'email_code')
        if (!factor?.email_address_id) throw new ClerkError(0, "This account can't get a sign-in code by email.")
        this.signIn = await this.request<SignIn>('POST', `/v1/client/sign_ins/${created.id}/prepare_first_factor`, { strategy: 'email_code', email_address_id: factor.email_address_id })
      } catch (error) {
        throw new Error(signInMessage(error))
      } finally {
        this.set({ busy: false })
      }
    },
    verify: async (code: string) => {
      const attempt = this.signIn
      if (!attempt) throw new Error('Ask for a new code.')
      this.set({ busy: true, error: null })
      try {
        const done = await this.request<SignIn>('POST', `/v1/client/sign_ins/${attempt.id}/attempt_first_factor`, { strategy: 'email_code', code: code.replace(/\s/g, '') })
        if (done.status !== 'complete') throw new ClerkError(0, 'This account needs another step to sign in, which only the Codync app can do.')
        this.signIn = null
        await this.refreshClient()
      } catch (error) {
        throw new Error(signInMessage(error))
      } finally {
        this.set({ busy: false })
      }
    },
    cancel: () => {
      this.signIn = null
    },
  }

  async signOut() {
    const session = this.activeSession
    if (this.state.busy || !session) return
    this.set({ busy: true, error: null })
    try {
      await this.request('POST', `/v1/client/sessions/${session.id}/remove`)
      this.cachedJWT = null
      await this.refreshClient()
    } catch {
      this.set({ error: "Couldn't sign out. Check your connection and try again." })
    } finally {
      this.set({ busy: false })
    }
  }

  /** The signed-in session's JWT for the Codync cloud (cached for under a minute). */
  async sessionToken(): Promise<string> {
    const session = this.activeSession
    if (!session) throw new Error('Sign in again to reach your account.')
    if (this.cachedJWT && this.cachedJWT.session === session.id && this.cachedJWT.until > Date.now()) return this.cachedJWT.jwt
    const res = await this.request<{ jwt?: string } | null>('POST', `/v1/client/sessions/${session.id}/tokens`)
    if (!res?.jwt) throw new Error('Sign in again to reach your account.')
    this.cachedJWT = { session: session.id, jwt: res.jwt, until: Date.now() + 50_000 }
    return res.jwt
  }

  /** The cloud's `/v1` API with the session and, for `signed`, this browser's device key for the account (§5). */
  async cloudRequest(method: string, path: string, body: unknown, signed: boolean) {
    const base = this.state.cloudURL
    const user = this.state.user
    if (!base || !user) return { ok: false as const, error: { status: 0, code: 'signedOut', message: 'Sign in again to reach your account.' } }
    const url = new URL(path.replace(/^\//, ''), `${base}/`)
    const payload = body === undefined ? new Uint8Array() : utf8Encoder.encode(JSON.stringify(body))
    const headers: Record<string, string> = {}
    try {
      headers.Authorization = `Bearer ${await this.sessionToken()}`
    } catch (error) {
      return { ok: false as const, error: { status: 401, code: 'signedOut', message: error instanceof Error ? error.message : 'Sign in again.' } }
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (signed) headers['Codync-Sig'] = await signRequest(await deviceKey(accountContext(user.userId)), method, url, payload)
    let res: ProxyAnswer
    try {
      res = await viaProxy(method, url, headers, body === undefined ? null : payload)
    } catch {
      res = { status: 0, headers: {}, body: new Uint8Array() }
    }
    if (res.status === 0) return { ok: false as const, error: { status: 0, code: 'unreachable', message: "Can't reach the Codync cloud. Check your connection." } }
    let json: Record<string, unknown> = {}
    try {
      const text = new TextDecoder().decode(res.body)
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {}
    } catch {}
    if (res.status >= 400) {
      const e = (json.error ?? {}) as { code?: string; message?: string }
      return { ok: false as const, error: { status: res.status, code: e.code ?? `http${res.status}`, message: e.message ?? null } }
    }
    return { ok: true as const, value: json as unknown }
  }
}

/** The Frontend API host is the publishable key's payload: `pk_live_<base64("host$")>`. */
function frontendAPI(key: string) {
  const host = atob(key.replace(/^pk_(test|live)_/, '')).replace(/\$$/, '')
  return `https://${host}`
}

function signInMessage(error: unknown) {
  if (error instanceof ClerkError) {
    if (error.code === 'form_identifier_not_found') return 'No Codync account uses this email. Create your account in the Codync app first.'
    if (error.code === 'form_code_incorrect') return "That code isn't right. Check the email and try again."
    if (error.code === 'verification_expired') return 'That code expired. Ask for a new one.'
    if (error.code === 'too_many_requests') return 'Too many tries. Wait a little and try again.'
    return error.message
  }
  return "Couldn't sign in. Check your connection and try again."
}
