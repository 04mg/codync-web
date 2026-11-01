// The web client's computers: each one paired with a link (§4.1) or approved through the account
// (§4.2 B), kept in this browser, and attached to the window's model as a `BotStore` over its own
// end-to-end encrypted channel. Only public keys and addresses are saved here; the device keys stay
// non-extractable in IndexedDB (channel/device-key.ts).

import type { AccessAsk, RemoteComputer, RemoteComputersBridge } from '@shared/ipc'
import type { Computer } from '@shared/models'
import type { AppModel } from '../renderer/store/app-model'
import { BotStore } from '../renderer/store/bot-store'
import { ChannelHostTransport, hostError } from './channel-host-transport'
import { deviceKey } from './channel/device-key'
import { pair } from './channel/pair'
import { type ChannelComputer, parsePairing } from './channel/pairing'
import { ChannelTransport } from './channel/transport'
import type { AccessAsks } from './account-access'
import { watchAttention } from './attention'
import { deviceName, webConfig, socketEnvironment } from './environment'

const STORAGE = 'codync-web-computers-v1'

export interface SavedComputer {
  computer: ChannelComputer
  source: 'pairing' | 'account'
  pairedAt: number
  /** Which device key this computer authorized: `local`, or the account's context. */
  context: string
}

function load(): SavedComputer[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE) ?? '[]') as SavedComputer[]
    return Array.isArray(raw) ? raw.filter((s) => s?.computer?.id && s.computer.signKey) : []
  } catch {
    return []
  }
}

export class RemoteComputers implements RemoteComputersBridge {
  private saved = load()
  private readonly channels = new Map<string, { channel: ChannelTransport; off: () => void }>()
  private app: AppModel | null = null
  private readonly listeners = new Set<() => void>()
  /** Account access requests (account-access.ts); set once the account side starts. */
  access: AccessAsks | null = null

  start(app: AppModel) {
    if (this.app) return
    this.app = app
    for (const s of this.saved) this.attach(s)
    watchAttention(app)
    // A tab coming back or the network returning: reconnect at once instead of waiting out a backoff.
    const wake = () => {
      for (const { channel } of this.channels.values()) if (channel.state.kind !== 'ready') channel.reconnect()
    }
    window.addEventListener('online', wake)
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && wake())
  }

  list(): RemoteComputer[] {
    return this.saved.map((s) => ({ id: s.computer.id, name: s.computer.name, source: s.source, pairedAt: s.pairedAt }))
  }

  onChange(cb: () => void) {
    this.listeners.add(cb)
    return () => void this.listeners.delete(cb)
  }

  notify() {
    for (const l of this.listeners) l()
  }

  async pair(link: string): Promise<string> {
    const config = webConfig()
    const pairing = parsePairing(link, { allowLocalCloud: config.allowLocalCloud })
    let computer: ChannelComputer
    try {
      computer = await pair(pairing, await deviceKey('local'), socketEnvironment(), deviceName(), config.allowLocalCloud)
    } catch (error) {
      throw new Error(hostError(error).message)
    }
    const previous = this.saved.find((s) => s.computer.id === computer.id)
    this.add({ computer: { ...computer, color: previous?.computer.color ?? null }, source: 'pairing', pairedAt: Date.now(), context: 'local' })
    return computer.name
  }

  /** A computer the account approved this device on (account-access.ts). */
  addApproved(computer: ChannelComputer, context: string) {
    this.add({ computer, source: 'account', pairedAt: Date.now(), context })
  }

  private add(s: SavedComputer) {
    this.saved = [...this.saved.filter((x) => x.computer.id !== s.computer.id), s]
    this.persist()
    this.attach(s)
    this.notify()
  }

  async forget(computerId: string) {
    this.detach(computerId)
    this.saved = this.saved.filter((s) => s.computer.id !== computerId)
    this.persist()
    this.notify()
  }

  /** Every computer from one account context (signing out of that account). */
  forgetContext(context: string) {
    for (const s of this.saved.filter((x) => x.context === context)) void this.forget(s.computer.id)
  }

  asks(): AccessAsk[] {
    return this.access?.list() ?? []
  }

  async ask(computer: { computerId: string; name: string; signKey: string }) {
    if (!this.access) throw new Error('Sign in to ask for access.')
    await this.access.ask(computer)
  }

  dismissAsk(computerId: string) {
    this.access?.dismiss(computerId)
  }

  has(computerId: string) {
    return this.saved.some((s) => s.computer.id === computerId)
  }

  private persist() {
    try {
      localStorage.setItem(STORAGE, JSON.stringify(this.saved))
    } catch (error) {
      console.warn("Couldn't save the computers", error)
    }
  }

  private attach(s: SavedComputer) {
    const app = this.app
    if (!app) return
    this.detach(s.computer.id)
    const channel = new ChannelTransport({
      computer: s.computer,
      device: deviceKey(s.context),
      env: socketEnvironment(),
      allowLocalCloud: webConfig().allowLocalCloud,
    })
    const cached = app.computers.find((c) => c.id === s.computer.id)
    const computer: Computer = { ...s.computer, color: cached?.color ?? s.computer.color ?? null }
    const store = new BotStore(computer, false, () => {
      // A refresh, or the store giving up waiting: try the link again now.
      if (channel.state.kind !== 'ready') channel.reconnect()
      return new ChannelHostTransport(channel)
    })
    const offs = [
      channel.onComputer((c) => {
        this.saved = this.saved.map((x) => (x.computer.id === c.id ? { ...x, computer: { ...c, color: x.computer.color ?? null } } : x))
        this.persist()
        store.updateComputer((old) => ({ ...old, name: c.name, boxKey: c.boxKey, urls: c.urls, cloud: c.cloud, device: c.device ?? old.device }))
        this.notify()
      }),
      channel.onMailbox((e) => store.mailboxOutcome(e.nonce, e.kind === 'delivered')),
      channel.onState((state) => {
        // Back up: resubscribe now rather than after the store's backoff.
        if (state.kind === 'ready' && store.connection.kind !== 'online') store.restartStream()
        // Revoked or needs an update: the store shows it on its next attempt.
        if (channel.stopped && store.connection.kind === 'online') store.restartStream()
      }),
    ]
    this.channels.set(s.computer.id, { channel: channel.start(), off: () => offs.forEach((off) => off()) })
    app.attach(computer, store)
  }

  private detach(computerId: string) {
    const link = this.channels.get(computerId)
    if (!link) return
    this.channels.delete(computerId)
    link.off()
    link.channel.shutdown()
    this.app?.detach(computerId)
  }
}
