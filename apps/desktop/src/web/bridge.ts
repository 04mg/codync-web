// `window.codync` for the web client: the desktop app's bridge (shared/ipc.ts), answered in the
// browser. Computers are reached over the end-to-end encrypted channel (remote-computers.ts), not a
// loopback host; what only a desktop app can do (menu bar, notch island, SSH tunnels, its own
// updates, on-device speech, OS permissions) reports itself unavailable, as on Linux.

import type { AccountState, CodyncBridge, HostSnapshot, UpdateState } from '@shared/ipc'
import { version } from '../../package.json'
import { AccessAsks } from './account-access'
import { WebAccount } from './account'
import { getAppearance, installAppearance, setAppearance } from './appearance'
import { artifacts } from './artifacts'
import { deleteDeviceKeys } from './channel/device-key'
import { notifications } from './attention'
import { deviceName, webConfig } from './environment'
import { files, pickFiles, readClipboardFiles } from './files'
import { RemoteComputers } from './remote-computers'
import { installShortcuts, onCommand, SHORTCUTS } from './shortcuts'

const none = () => () => {}
const unavailable = (what: string) => () => Promise.reject(new Error(`${what} isn't available in the web client.`))

const snapshot: HostSnapshot = { state: { kind: 'none' }, local: null, dev: false, logPath: '' }
const updates: UpdateState = {
  supported: false, checking: false, availableVersion: null, downloadPercent: null, staged: false, installing: false,
  autoCheck: false, autoDownload: false, lastCheck: null, error: null,
}

/** Builds the bridge; `loadWebConfig()` must have finished. */
export function installBridge() {
  installAppearance()
  installShortcuts()
  const account = new WebAccount()
  const remote = new RemoteComputers()
  remote.access = new AccessAsks(account, (c, context) => remote.addApproved({ ...c, boxKey: null, urls: [] }, context), () => remote.notify())
  // Signing out of an account takes its computers off this browser too (they authorized that account's key).
  account.onSignedOut = (context) => remote.forgetContext(context)

  const bridge: CodyncBridge = {
    // The renderer's platform choices (Lucide icons, voice engines, copy) are Linux's: no SF Symbols,
    // no on-device speech, no Mac-only settings.
    platform: 'linux',
    runtime: 'web',
    remote,
    browser: {
      notifications: { supported: notifications.supported, enabled: () => notifications.enabled, set: (on) => notifications.set(on) },
      shortcuts: SHORTCUTS,
      serverVersion: webConfig().version,
      signOut: webConfig().signInRequired
        ? async () => {
            await fetch('auth/logout', { method: 'POST' }).catch(() => {})
            location.reload()
          }
        : null,
    },
    appName: 'Codync',
    appScheme: 'codync',
    hostPort: 19222,
    appVersion: version,
    computerName: deviceName(),
    openedAtLogin: false,
    debugOpen: new URLSearchParams(location.search).get('open'),
    host: {
      snapshot: async () => snapshot,
      onChange: none,
      install() {},
      restart() {},
      call: unavailable('A local host'),
      stream: (_url, _token, _onData, onEnd) => {
        queueMicrotask(() => onEnd({ status: 0, message: "The web client doesn't run a host." }))
        return () => {}
      },
    },
    account: {
      state: async (): Promise<AccountState> => account.state,
      onChange: (cb) => account.onChange(cb),
      signIn: () => account.signInWithProvider(),
      signOut: () => account.signOut(),
      token: () => account.sessionToken(),
      email: account.email,
    },
    speech: { available: false, locales: () => [], start() {}, stop() {}, onEvent: none, shortcut: async () => 'off', setShortcut: async () => 'off', setCalling() {} },
    ssh: {
      state: async () => ({ profiles: [], status: {}, attachments: [] }),
      onChange: none,
      save: async () => "SSH isn't available in the web client.",
      remove() {},
      connect() {},
      disconnect() {},
      trustHostKey() {},
      chooseKey: async () => null,
      configHosts: async () => ({ access: 'denied', hosts: [] }),
      setConfigAccess: async () => ({ access: 'denied', hosts: [] }),
    },
    island: {
      supported: false,
      enabled: async () => false,
      setEnabled: async () => false,
      setSummary() {},
      state: async () => ({ screen: { notch: null }, summary: { bots: [], permissions: [], usage: [] } }),
      onSummary: none,
      onScreen: none,
      onHover: none,
      setShape() {},
      setFocusable() {},
      setKeys() {},
      onKey: none,
      onVoiceKey: none,
      respond() {},
      send() {},
      openBot() {},
      newBot() {},
      openApp() {},
    },
    cloud: { request: (method, path, body, signed) => account.cloudRequest(method, path, body, signed) },
    updates: { state: async () => updates, onChange: none, check() {}, install() {}, setAutoCheck() {}, setAutoDownload() {} },
    artifacts,
    files,
    app: {
      reportError: (report) => console.error('Codync error', report),
      openExternal: (url) => {
        if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) window.open(url, '_blank', 'noopener,noreferrer')
      },
      copy: (text) => void navigator.clipboard?.writeText(text).catch(() => {}),
      pickFiles,
      // A bot export is read from a path on the computer itself: import with `codync-host import` there.
      pickExport: async () => null,
      readClipboardFiles,
      setTraySummary() {},
      onCommand,
      resetAllData: async () => {
        await deleteDeviceKeys().catch(() => {})
        for (const name of await caches.keys().catch(() => [])) await caches.delete(name).catch(() => false)
        for (const reg of await navigator.serviceWorker?.getRegistrations().catch(() => []) ?? []) await reg.unregister().catch(() => false)
        try {
          localStorage.clear()
          sessionStorage.clear()
        } catch {}
        await fetch('auth/logout', { method: 'POST' }).catch(() => {})
        location.replace(new URL('.', document.baseURI).toString())
      },
      setLaunchAtLogin: async () => false,
      appearance: async () => getAppearance(),
      setAppearance: async (value) => setAppearance(value),
      showInDock: async () => false,
      setShowInDock: async () => false,
      launchAtLogin: async () => false,
      openSettings() {},
      authenticate: connectorSignIn,
      screenAgentState: async () => ({ available: false, needsApproval: false, registered: false }),
      setScreenAgent: unavailable('Codync Screen'),
      syncScreenAgent: async () => ({ needsApproval: false }),
    },
  }
  window.codync = bridge
}

/**
 * A connector's sign-in (`connectorSignIn` with the app callback): the provider's page opens in a new
 * tab and ends on the cloud's callback page, which hands the code to an app link a browser can't
 * follow. The person pastes that page's address here and the code goes to the computer, which
 * alone holds the PKCE verifier.
 */
async function connectorSignIn(url: string, scheme: string): Promise<string> {
  window.open(url, '_blank', 'noopener')
  const pasted = window.prompt('Sign in in the new tab. When it finishes (or shows an error), copy that tab\'s address and paste it here.')
  if (!pasted) throw new Error('cancelled')
  let back: URL
  try {
    back = new URL(pasted.trim())
  } catch {
    throw new Error('cancelled')
  }
  const items = back.searchParams
  if (!items.get('state')) throw new Error('cancelled')
  const out = new URL(`${scheme}://oauth`)
  for (const k of ['code', 'state', 'error', 'error_description']) {
    const v = items.get(k)
    if (v !== null) out.searchParams.set(k, v)
  }
  return out.toString()
}
