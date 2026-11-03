import type { SignInFailure, SignInProvider } from './analytics'
import type { SharedFile } from './models'
import type { SSHBridge } from './ssh'
import type { ScreenAgentState } from './computer-access'
import type { IslandRect, IslandScreen, IslandSummary } from './island'
import type { VoiceKey, VoiceShortcut } from './voice-shortcut'
import type { ErrorReport } from './error-report'
import type { Appearance } from './appearance'

// The bridge between the main process (host lifecycle, loopback HTTP, tray, windows)
// and the renderer (stores and UI). Exposed as `window.codync` by the preload script.

export type HostState =
  /** This app runs no host of its own (the web client): every computer is reached remotely. */
  | { kind: 'none' }
  | { kind: 'missingBinary' }
  | { kind: 'notInstalled' }
  | { kind: 'starting' }
  | { kind: 'running' }
  | { kind: 'failed'; message: string }

/** This computer's own host, once it answered. */
export interface LocalHost {
  computerId: string
  baseURL: string
  token: string
}

export interface HostSnapshot {
  state: HostState
  local: LocalHost | null
  /** Started against a manually run host (`CODYNC_PORT`). */
  dev: boolean
  logPath: string
}

export interface CallError {
  status: number
  message: string
}

/** A menu image as PNG data URLs drawn for 1x and 2x screens; each screen shows its own. */
export interface TrayImage {
  x1: string
  x2: string
}

/** What the tray menu shows; the renderer owns the stores and sends this on every change. */
/** The SF Symbols beside the tray menu's actions. */
export const TRAY_SYMBOLS = [
  'macwindow',
  'qrcode',
  'square.on.square',
  'arrow.down.circle',
  'arrow.clockwise.circle',
  'list.bullet.rectangle',
  'person.crop.circle.badge.checkmark',
  'display',
  'gearshape',
  'power',
] as const
export type TraySymbol = (typeof TRAY_SYMBOLS)[number]

export interface TraySummary {
  status: string
  canPair: boolean
  bots: { ref: string; name: string; detail: string; working: boolean; avatar: TrayImage | null }[]
  approval: string | null
  usage: { name: string; icon: TrayImage | null; lines: { title: string; bar: TrayImage | null }[] }[]
  screen: {
    enabled: boolean
    subtitle: string
    error: string | null
  } | null
  /** This computer's networks (codync-network), lines already translated; null on hosts without them. */
  networks: { title: string; computers: { label: string; dot: TrayImage | null }[] }[] | null
  /** The Network row's codync-network mark (SF Symbols has none), drawn on every platform; a template image on macOS. */
  networkIcon: TrayImage | null
  /** Windows and Linux: the actions' symbols drawn by the renderer (macOS menus draw SF Symbols); null on macOS. */
  symbols: Partial<Record<TraySymbol, TrayImage>> | null
  needsAttention: boolean
  textSize: number
  usageIconStyle: 'character' | 'original'
  /** The menu bar is a system menu, so the main process translates its labels from this. */
  language: 'en' | 'zh' | 'zh-Hant' | 'ja' | 'ko' | 'fr' | 'de' | 'es' | 'pt-BR' | 'ru'
}

/** Things the tray menu (or the app menu) asks the window to do. */
export type WindowCommand =
  | { kind: 'openBot'; ref: string }
  | { kind: 'stopBot'; ref: string }
  | { kind: 'reviewApprovals' }
  | { kind: 'confirmReset' }
  | { kind: 'upToDate' }
  | { kind: 'setTextSize'; size: number }
  | { kind: 'stepTextSize'; up: boolean | null }
  | { kind: 'setUsageIconStyle'; style: 'character' | 'original' }
  | { kind: 'setRemoteScreen'; on: boolean }
  | { kind: 'computerAccess' }
  | { kind: 'networkSettings' }
  | { kind: 'newBot' }
  | { kind: 'search' }
  | { kind: 'toggleSidebar' }
  | { kind: 'toggleDetails' }
  | { kind: 'refresh' }
  | { kind: 'respondPermission'; ref: string; entryId: string; optionId: string }
  | { kind: 'sendMessage'; ref: string; text: string }
  /** The voice input shortcut, while the island is off: a double tap starts dictating into the composer, a tap sends. */
  | { kind: 'voiceKey'; key: VoiceKey }
  /** The chat window was shown again after being hidden (`window_opened`). */
  | { kind: 'windowOpened' }

/** The app's own updates (electron-updater, release builds only). */
export interface UpdateState {
  supported: boolean
  checking: boolean
  availableVersion: string | null
  /** Downloading: percent done (0–100); null when nothing is downloading. */
  downloadPercent: number | null
  /** Downloaded and ready: installs on restart. */
  staged: boolean
  /** Restarting into the staged release (the host stops first). */
  installing: boolean
  autoCheck: boolean
  autoDownload: boolean
  lastCheck: number | null
  error: string | null
}

export interface AccountState {
  /** The persisted session has been restored (or there was none). */
  ready: boolean
  /** This build has a Clerk key and a cloud. */
  configured: boolean
  busy: boolean
  error: string | null
  user: { userId: string; email: string | null; avatarURL: string | null } | null
  cloudURL: string | null
}

export type SpeechEvent =
  | { type: 'partial' | 'final'; text: string }
  | { type: 'level'; value: number }
  | { type: 'started' }
  | { type: 'stopped' }
  | { type: 'error'; message: string }

/** A dropped, pasted or picked file: its name and bytes. */
export type PickedFile = { name: string; data: Uint8Array }

/** A computer reached over the end-to-end encrypted channel, as `RemoteComputersBridge` lists it. */
export interface RemoteComputer {
  id: string
  name: string
  /** How this device was authorized: a pairing link, or an approval through the account. */
  source: 'pairing' | 'account'
  /** When this device was paired (ms). */
  pairedAt: number
}

/** A computer in the account this device asked to use (§4.2 B): its code to confirm on the computer. */
export interface AccessAsk {
  computerId: string
  name: string
  state: 'asking' | 'waitingForCode' | 'confirm' | 'approved' | 'denied' | 'expired' | 'failed'
  /** The 6-digit code to compare on the computer, once both sides committed. */
  sas: string | null
  message: string | null
}

/**
 * Computers this app reaches over Codync's end-to-end encrypted channel (spec §6, §7): the web
 * client's way to every computer. Absent in the desktop app, which reaches computers over loopback.
 */
export interface RemoteComputersBridge {
  /** Attaches every saved computer to the window's model; call once. */
  start(app: import('../renderer/store/app-model').AppModel): void
  list(): RemoteComputer[]
  onChange(cb: () => void): () => void
  /** Pairs with a `codync://pair?…` link (§4.1); resolves to the computer's name. */
  pair(link: string): Promise<string>
  /** Forgets a computer on this device; the computer keeps listing this device until it's revoked there. */
  forget(computerId: string): Promise<void>
  /** Account computers this device asked to use, with their codes. */
  asks(): AccessAsk[]
  /** Starts asking an account computer for access (commit-then-reveal SAS, §4.2 B). */
  ask(computer: { computerId: string; name: string; signKey: string }): Promise<void>
  /** Stops waiting for an ask (the request expires on its own). */
  dismissAsk(computerId: string): void
}

/** What only the web client has: its tab's notifications, its keys, and its own server's session. */
export interface BrowserBridge {
  notifications: { supported: boolean; enabled(): boolean; set(on: boolean): Promise<boolean> }
  /** The desktop menu's shortcuts as the browser takes them. */
  shortcuts: { keys: string; title: string }[]
  /** codync-web's version. */
  serverVersion: string
  /** Signs out of the codync-web server; null when it has no sign-in. */
  signOut: (() => Promise<void>) | null
}

/** The account sign-in a browser can finish on its own: a code sent by email (no app redirect needed). */
export interface EmailSignInBridge {
  /** Sends a code to `email`; rejects with a message to show. */
  start(email: string): Promise<void>
  /** Finishes with the code from the email; rejects with a message to show. */
  verify(code: string): Promise<void>
  cancel(): void
}

export interface CodyncBridge {
  platform: 'darwin' | 'linux' | 'win32'
  /** The desktop app (Electron), or the web client served by codync-web. */
  runtime: 'desktop' | 'web'
  /** The web client's computers; absent in the desktop app. */
  remote?: RemoteComputersBridge
  /** The web client's browser-only settings; absent in the desktop app. */
  browser?: BrowserBridge
  appName: string
  appScheme: string
  hostPort: number
  appVersion: string
  /** The computer's name ("Kevin's MacBook Pro"). */
  computerName: string
  /** This launch was started by the login item (Open at login). */
  openedAtLogin: boolean
  /** Screenshot/UI checks: CODYNC_DEBUG_OPEN=newBot | newGroup | plugins | computers | <bot name>. */
  debugOpen: string | null
  host: {
    snapshot(): Promise<HostSnapshot>
    onChange(cb: (s: HostSnapshot) => void): () => void
    install(): void
    restart(): void
    /** POST /api/<method> on a loopback host. Rejects with a `CallError`. */
    call(baseURL: string, token: string, method: string, body: unknown, timeoutMs: number): Promise<unknown>
    /** SSE on a loopback host: each `data:` line, then `onEnd` (with an error when it failed). */
    stream(url: string, token: string, onData: (line: string) => void, onEnd: (error: CallError | null) => void): () => void
  }
  account: {
    state(): Promise<AccountState>
    onChange(cb: (s: AccountState) => void): () => void
    /** Why it ended without an account; null once signed in (or while another sign-in runs). */
    signIn(provider: SignInProvider): Promise<SignInFailure | null>
    signOut(): Promise<void>
    /** Deletes the signed-in Codync account in Clerk; false when it couldn't (nothing changed). */
    deleteAccount(): Promise<boolean>
    /** The signed-in session's JWT for the Codync cloud. */
    token(): Promise<string>
    /** The web client signs in with an emailed code instead of an Apple or Google redirect. */
    email?: EmailSignInBridge
  }
  /** On-device speech recognition (macOS: SFSpeechRecognizer in a helper; unavailable on Linux). */
  speech: {
    available: boolean
    /** The languages it can transcribe, as locale identifiers. */
    locales(): string[]
    /** `locale` null: the computer's language. */
    start(locale: string | null): void
    stop(): void
    onEvent(cb: (e: SpeechEvent) => void): () => void
    /** The voice input shortcut (Settings → General); always `off` without on-device speech. */
    shortcut(): Promise<VoiceShortcut>
    setShortcut(shortcut: VoiceShortcut): Promise<VoiceShortcut>
    /** A call is on (or over): it has the microphone, so the voice input shortcut does nothing meanwhile. */
    setCalling(on: boolean): void
  }
  ssh: SSHBridge
  /** The notch island (shared/island.ts): its setting, the chat window's summary, and the island window's side. */
  island: {
    /** False where a window can't place itself at the top of the screen (Linux on Wayland). */
    supported: boolean
    enabled(): Promise<boolean>
    setEnabled(on: boolean): Promise<boolean>
    setSummary(summary: IslandSummary): void
    state(): Promise<{ screen: IslandScreen; summary: IslandSummary }>
    onSummary(cb: (summary: IslandSummary) => void): () => void
    onScreen(cb: (screen: IslandScreen) => void): () => void
    /** The pointer reached or left the shape. */
    onHover(cb: (inside: boolean) => void): () => void
    setShape(rect: IslandRect): void
    /** The message field takes the keyboard (the island never does otherwise). */
    setFocusable(on: boolean): void
    /** ⌥Y / ⌥N answer the approval on screen, from any app, while it shows. */
    setKeys(on: boolean): void
    onKey(cb: (answer: 'allow' | 'deny') => void): () => void
    /** The voice input shortcut's taps, from any app, while the island is on. */
    onVoiceKey(cb: (key: VoiceKey) => void): () => void
    respond(ref: string, entryId: string, optionId: string): void
    send(ref: string, text: string): void
    openBot(ref: string): void
    newBot(): void
    openApp(): void
  }
  /** The Codync cloud's `/v1` API with the signed-in session (and the device key for `signed`). */
  cloud: {
    request(method: string, path: string, body: unknown, signed: boolean): Promise<{ ok: true; value: unknown } | { ok: false; error: { status: number; code: string; message: string | null } }>
  }
  updates: {
    state(): Promise<UpdateState>
    onChange(cb: (s: UpdateState) => void): () => void
    check(): void
    /** Downloads the available release if needed, then restarts into it. */
    install(): void
    setAutoCheck(on: boolean): void
    setAutoDownload(on: boolean): void
  }
  /** Artifacts shown in a frame of their own (`main/artifacts.ts`). */
  artifacts: {
    /** Makes `codync-artifact://<id>` serve this HTML. */
    show(id: string, html: Uint8Array): Promise<void>
    /** Where a shown artifact's frame loads from, when not `codync-artifact://` (the web client's service worker). */
    frameURL?(id: string, version: number, preview: boolean): string
    openInBrowser(id: string, html: Uint8Array): Promise<void>
  }
  files: {
    begin(file: SharedFile): Promise<string | null>
    write(id: string, offset: number, data: Uint8Array): Promise<void>
    finish(id: string): Promise<void>
    cancel(id: string): Promise<void>
  }
  app: {
    /** Error tracking: an uncaught error in this window (shared/error-report.ts). */
    reportError(report: ErrorReport): void
    openExternal(url: string): void
    copy(text: string): void
    /** Files picked in the system dialog: name and bytes. */
    pickFiles(): Promise<PickedFile[]>
    /** A bot export (.zip) picked in the system dialog: its path on this computer, or null. */
    pickExport(): Promise<string | null>
    readClipboardFiles(): Promise<PickedFile[]>
    setTraySummary(summary: TraySummary): void
    /** Brings the chat window forward (a phone waits for this computer to let it in). */
    showWindow(): void
    onCommand(cb: (command: WindowCommand) => void): () => void
    resetAllData(): Promise<void>
    setLaunchAtLogin(on: boolean): Promise<boolean>
    appearance(): Promise<Appearance>
    setAppearance(value: Appearance): Promise<Appearance>
    showInDock(): Promise<boolean>
    setShowInDock(on: boolean): Promise<boolean>
    launchAtLogin(): Promise<boolean>
    openSettings(url: string): void
    /**
     * Opens `url` in the system browser and resolves with the URL it returns to on `scheme`
     * (`codync://…`), like ASWebAuthenticationSession. Rejects when cancelled or timed out.
     */
    authenticate(url: string, scheme: string): Promise<string>
    /** macOS: registers or removes the Codync Screen agent (SMAppService). */
    screenAgentState(): Promise<ScreenAgentState>
    setScreenAgent(on: boolean): Promise<{ needsApproval: boolean }>
    syncScreenAgent(enabled: boolean): Promise<{ needsApproval: boolean }>
  }
}
