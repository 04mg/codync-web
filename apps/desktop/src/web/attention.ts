// What the desktop app's menu bar and the phones' notifications say, for a browser tab: the tab's
// title counts the bots that need you, and while the tab is in the background a browser
// notification says when a bot needs you, finished or failed (when the person allowed them).

import type { AppModel } from '../renderer/store/app-model'
import { refKey } from '../renderer/store/app-model'

const KEY = 'codync-web-notifications'

export const notifications = {
  get supported() {
    return 'Notification' in window
  },
  get enabled() {
    try {
      return this.supported && Notification.permission === 'granted' && localStorage.getItem(KEY) !== 'off'
    } catch {
      return false
    }
  },
  /** Turns them on (asking the browser) or off; whether they're on now. */
  async set(on: boolean): Promise<boolean> {
    try {
      localStorage.setItem(KEY, on ? 'on' : 'off')
    } catch {}
    if (on && this.supported && Notification.permission === 'default') await Notification.requestPermission()
    return this.enabled
  },
}

export function watchAttention(app: AppModel) {
  const statuses = new Map<string, string>()
  const watched = new Map<unknown, () => void>()
  let seeded = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const notify = (title: string, body: string, ref: string) => {
    if (!notifications.enabled || document.visibilityState === 'visible') return
    const n = new Notification(title, { body: body.slice(0, 180), tag: ref, icon: 'icon.png' })
    n.onclick = () => {
      window.focus()
      const at = ref.indexOf('/')
      app.select({ computerId: ref.slice(0, at), botId: ref.slice(at + 1) })
      n.close()
    }
  }

  const update = () => {
    timer = null
    const roster = app.roster
    const needs = roster.filter((i) => i.bot.status === 'needsInput').length
    const unread = roster.filter((i) => i.bot.unread > 0).length
    const count = needs || unread
    document.title = count ? `(${count}) ${window.codync.appName}` : window.codync.appName
    for (const { ref, bot } of roster) {
      const key = refKey(ref)
      const before = statuses.get(key)
      statuses.set(key, bot.status)
      if (!seeded || before === undefined || before === bot.status) continue
      const said = bot.lastMessage ?? ''
      if (bot.status === 'needsInput') notify(`${bot.name} needs you`, said, key)
      else if (bot.status === 'error') notify(`${bot.name} failed`, said, key)
      else if (before === 'working' && bot.status === 'idle') notify(`${bot.name} is done`, said, key)
    }
    // Statuses from the first catch-up are history, not news.
    seeded = roster.length > 0
  }
  const schedule = () => {
    timer ??= setTimeout(update, 400)
  }
  const follow = () => {
    for (const store of app.stores.values()) if (!watched.has(store)) watched.set(store, store.subscribe(schedule))
    for (const [store, off] of watched) {
      if ([...app.stores.values()].includes(store as never)) continue
      off()
      watched.delete(store)
    }
    schedule()
  }
  app.subscribe(follow)
  follow()
}
