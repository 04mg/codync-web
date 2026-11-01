// The desktop app's menu shortcuts, in the browser. The browser keeps ⌘/Ctrl+N, T, W and R for
// itself, so those commands move to ⌥ (Alt) combinations; the rest keep their desktop keys.

import type { WindowCommand } from '@shared/ipc'
import { isMacBrowser } from './environment'

type Listener = (c: WindowCommand) => void

const listeners = new Set<Listener>()

export function onCommand(cb: Listener) {
  listeners.add(cb)
  return () => void listeners.delete(cb)
}

export function sendCommand(c: WindowCommand) {
  for (const l of [...listeners]) l(c)
}

/** The keys, as shown in Settings → General. */
export const SHORTCUTS: { keys: string; title: string }[] = [
  { keys: `${isMacBrowser ? '⌘' : 'Ctrl+'}K`, title: 'Search bots' },
  { keys: `${isMacBrowser ? '⌥⌘' : 'Ctrl+Alt+'}N`, title: 'New bot' },
  { keys: `${isMacBrowser ? '⌥⌘' : 'Ctrl+Alt+'}R`, title: 'Refresh' },
  { keys: `${isMacBrowser ? '⌥⌘' : 'Ctrl+Alt+'}S`, title: 'Toggle sidebar' },
  { keys: `${isMacBrowser ? '⌥⌘' : 'Ctrl+Alt+'}I`, title: 'Conversation details' },
  { keys: `${isMacBrowser ? '⌘' : 'Ctrl+'}= / - / 0`, title: 'Text size' },
]

export function installShortcuts() {
  window.addEventListener('keydown', (e) => {
    const mod = isMacBrowser ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
    if (!mod || e.repeat) return
    const key = e.code
    let command: WindowCommand | null = null
    if (e.altKey && !e.shiftKey) {
      command = key === 'KeyN' ? { kind: 'newBot' }
        : key === 'KeyR' ? { kind: 'refresh' }
        : key === 'KeyS' ? { kind: 'toggleSidebar' }
        : key === 'KeyI' ? { kind: 'toggleDetails' }
        : null
    } else if (!e.altKey) {
      command = key === 'KeyK' && !e.shiftKey ? { kind: 'search' }
        : key === 'Equal' || key === 'NumpadAdd' ? { kind: 'stepTextSize', up: true }
        : key === 'Minus' || key === 'NumpadSubtract' ? { kind: 'stepTextSize', up: false }
        : key === 'Digit0' || key === 'Numpad0' ? { kind: 'stepTextSize', up: null }
        : null
    }
    if (!command) return
    e.preventDefault()
    sendCommand(command)
  }, { capture: true })
  // A tab shown again plays the desktop's window coming back.
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && sendCommand({ kind: 'windowOpened' }))
}
