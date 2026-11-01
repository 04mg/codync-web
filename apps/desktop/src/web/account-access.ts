// Asking an account computer for access (spec §4.2 B), as the iPhone app does: commit to a device
// nonce, wait for the computer's nonce, reveal ours, show the 6-digit code the person compares on
// the computer, and once the computer approves, connect over the relay. The code is what keeps a
// compromised cloud from slipping in another key: it covers both nonces, this browser's key and the
// computer's.

import type { AccessAsk } from '@shared/ipc'
import { b64url, random, sasCode, sasCommit, unb64url } from './channel/crypto'
import { deviceKey } from './channel/device-key'
import { accountContext, type WebAccount } from './account'

interface Ask extends AccessAsk {
  requestId: string | null
  signKey: string
  context: string
  /** Our nonce, kept only in memory (§4.2 B step 3). */
  nD: Uint8Array
  stopped: boolean
}

const POLL_MS = 2000

export class AccessAsks {
  private readonly asks = new Map<string, Ask>()
  private readonly account: WebAccount
  private readonly approved: (computer: { id: string; name: string; signKey: string; cloud: string }, context: string) => void
  private readonly changed: () => void

  constructor(account: WebAccount, approved: AccessAsks['approved'], changed: () => void) {
    this.account = account
    this.approved = approved
    this.changed = changed
  }

  list(): AccessAsk[] {
    return [...this.asks.values()].map(({ computerId, name, state, sas, message }) => ({ computerId, name, state, sas, message }))
  }

  dismiss(computerId: string) {
    const ask = this.asks.get(computerId)
    if (!ask) return
    ask.stopped = true
    this.asks.delete(computerId)
    if (ask.requestId && (ask.state === 'asking' || ask.state === 'waitingForCode' || ask.state === 'confirm')) {
      void this.account.cloudRequest('DELETE', `v1/access-requests/${ask.requestId}`, undefined, false)
    }
    this.changed()
  }

  async ask(computer: { computerId: string; name: string; signKey: string }) {
    const user = this.account.state.user
    const cloud = this.account.state.cloudURL
    if (!user || !cloud) throw new Error('Sign in to ask for access.')
    if (unb64url(computer.signKey).length !== 32) throw new Error("This computer's key is damaged.")
    // A new ask replaces an earlier one (the cloud cancels its pending request too).
    this.dismiss(computer.computerId)
    const context = accountContext(user.userId)
    const device = await deviceKey(context)
    const ask: Ask = { ...computer, state: 'asking', sas: null, message: null, requestId: null, context, nD: random(32), stopped: false }
    this.asks.set(computer.computerId, ask)
    this.changed()
    const created = await this.account.cloudRequest('POST', `v1/computers/${computer.computerId}/access-requests`, { commit: b64url(sasCommit(device.publicKey, ask.nD)) }, true)
    if (!created.ok) return this.fail(ask, created.error.message ?? "Couldn't ask for access.")
    ask.requestId = (created.value as { requestId: string }).requestId
    this.update(ask, { state: 'waitingForCode' })
    void this.poll(ask, device.publicKey, cloud)
  }

  private update(ask: Ask, change: Partial<Ask>) {
    Object.assign(ask, change)
    this.changed()
  }

  private fail(ask: Ask, message: string) {
    this.update(ask, { state: 'failed', message })
  }

  private async poll(ask: Ask, dk: Uint8Array, cloud: string) {
    while (!ask.stopped) {
      await new Promise((r) => setTimeout(r, POLL_MS))
      if (ask.stopped) return
      const res = await this.account.cloudRequest('GET', `v1/access-requests/${ask.requestId}`, undefined, false)
      if (!res.ok) {
        if (res.error.status === 0) continue
        return this.fail(ask, res.error.message ?? "Couldn't check the request.")
      }
      const r = res.value as { status: string; hostNonce?: string }
      if (r.status === 'approved') {
        this.update(ask, { state: 'approved' })
        this.approved({ id: ask.computerId, name: ask.name, signKey: ask.signKey, cloud }, ask.context)
        // Its row turns into the computer itself.
        setTimeout(() => {
          if (this.asks.get(ask.computerId) === ask) this.asks.delete(ask.computerId)
          this.changed()
        }, 3000)
        return
      }
      if (r.status === 'denied' || r.status === 'cancelled') return this.update(ask, { state: 'denied', message: 'The computer said no.' })
      if (r.status === 'expired') return this.update(ask, { state: 'expired', message: 'The request expired. Ask again.' })
      if (r.hostNonce && ask.sas === null) {
        // Reveal only after the computer committed its nonce, then show the code (§4.2 B step 5).
        const revealed = await this.account.cloudRequest('POST', `v1/access-requests/${ask.requestId}/reveal`, { nonce: b64url(ask.nD) }, true)
        if (!revealed.ok && revealed.error.code !== 'conflict') return this.fail(ask, revealed.error.message ?? "Couldn't finish the request.")
        this.update(ask, { state: 'confirm', sas: sasCode(unb64url(ask.signKey), dk, ask.nD, unb64url(r.hostNonce)) })
      }
    }
  }
}

export { accountContext }
