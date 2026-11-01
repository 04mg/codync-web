// Light, Dark or System for the web client. Electron sets `nativeTheme.themeSource`, which every
// `prefers-color-scheme` query follows; a page can't, so the web build's theme.css also keys its
// dark palette on `data-appearance` (vite.web.config.ts), and this answers the app's own
// `matchMedia('(prefers-color-scheme: dark)')` reads (lib/theme.ts) the same way.

import { appearance as parseAppearance, type Appearance } from '@shared/appearance'

const KEY = 'codync-web-appearance'
const nativeMatchMedia = window.matchMedia.bind(window)
const system = nativeMatchMedia('(prefers-color-scheme: dark)')

let current: Appearance = (() => {
  try {
    return parseAppearance(localStorage.getItem(KEY))
  } catch {
    return 'system'
  }
})()

const isDark = () => (current === 'system' ? system.matches : current === 'dark')

/** A `MediaQueryList` for the dark query that follows the chosen appearance. */
class AppearanceQuery extends EventTarget implements MediaQueryList {
  readonly media: string
  onchange: ((this: MediaQueryList, ev: MediaQueryListEvent) => unknown) | null = null
  constructor(media: string) {
    super()
    this.media = media
  }
  get matches() {
    return isDark()
  }
  addListener(cb: ((this: MediaQueryList, ev: MediaQueryListEvent) => unknown) | null) {
    if (cb) this.addEventListener('change', cb as EventListener)
  }
  removeListener(cb: ((this: MediaQueryList, ev: MediaQueryListEvent) => unknown) | null) {
    if (cb) this.removeEventListener('change', cb as EventListener)
  }
  notify() {
    const event = new Event('change') as MediaQueryListEvent
    this.onchange?.call(this, event)
    this.dispatchEvent(event)
  }
}

const queries = new Set<AppearanceQuery>()

function apply() {
  const root = document.documentElement
  root.dataset.appearance = current
  root.style.colorScheme = current === 'system' ? 'light dark' : current
  for (const q of queries) q.notify()
}

export function installAppearance() {
  window.matchMedia = (query: string) => {
    if (!/prefers-color-scheme:\s*dark/.test(query)) return nativeMatchMedia(query)
    const q = new AppearanceQuery(query)
    queries.add(q)
    return q
  }
  system.addEventListener('change', () => current === 'system' && apply())
  apply()
}

export function getAppearance(): Appearance {
  return current
}

export function setAppearance(value: Appearance): Appearance {
  current = parseAppearance(value)
  try {
    localStorage.setItem(KEY, current)
  } catch {}
  apply()
  return current
}
