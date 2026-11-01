// This Codync Web's device keys (§3.2), kept on the codync-web server and shared by every browser
// that uses it, like the account sign-in: one Ed25519 key per account context (`local` for
// computers paired with a link, one per signed-in account otherwise, so accounts can't be linked
// through it). The private keys never reach a browser: it asks the server to sign
// (apps/web/internal/server/device.go). The cloud and the computers only ever see the public half.

import type { DeviceSigner } from './crypto.ts'
import { unb64url } from './crypto.ts'

/** A request to the server's device API; an ended server session shows its sign-in page. */
export async function deviceRequest(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`device/${path}`, { cache: 'no-store', ...init })
  if (res.status === 401) {
    location.reload()
    throw new Error('Sign in to this server again.')
  }
  if (!res.ok) throw new Error(`The server refused the request (${res.status}).`)
  return res
}

const loaded = new Map<string, Promise<DeviceSigner>>()

/** The device key for an account context, made on the server on first use. */
export function deviceKey(context = 'local'): Promise<DeviceSigner> {
  const cached = loaded.get(context)
  if (cached) return cached
  const path = `keys/${encodeURIComponent(context)}`
  const loading = (async (): Promise<DeviceSigner> => {
    const { publicKey } = (await (await deviceRequest(path)).json()) as { publicKey: string }
    return {
      publicKey: unb64url(publicKey),
      sign: async (message) => {
        const res = await deviceRequest(`${path}/sign`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: message as Uint8Array<ArrayBuffer> })
        return new Uint8Array(await res.arrayBuffer())
      },
    }
  })()
  loaded.set(context, loading)
  loading.catch(() => loaded.delete(context))
  return loading
}

/** Forgets the device ("Reset all data"): every computer has to pair with this server again. */
export async function resetDevice() {
  loaded.clear()
  await deviceRequest('reset', { method: 'POST' })
}
