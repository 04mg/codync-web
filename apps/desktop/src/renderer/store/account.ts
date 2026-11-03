import type { SignInProvider } from '@shared/analytics'
import { Observable, useModel } from '../lib/observable'
import { analytics } from './analytics'

export interface AccountInfo {
  userId: string
  email: string | null
  avatarURL: string | null
}

/**
 * The Codync account (Clerk, through the main process). An account never grants access to a
 * computer by itself: each one still approves this device (spec §4.2).
 */
export class AccountSession extends Observable {
  isBusy = false
  isReady = true
  isConfigured = false
  errorMessage: string | null = null
  user: AccountInfo | null = null
  cloudURL: string | null = null
  /** The last sign-in started here, for `signed_in`. */
  provider: SignInProvider | null = null

  get isSignedIn() {
    return this.user !== null
  }

  async start() {
    const state = await window.codync.account.state()
    this.apply(state)
    window.codync.account.onChange((s) => this.apply(s))
  }

  private apply(s: Awaited<ReturnType<typeof window.codync.account.state>>) {
    this.isReady = s.ready
    this.isConfigured = s.configured
    this.isBusy = s.busy
    this.errorMessage = s.error
    this.user = s.user
    this.cloudURL = s.cloudURL
    this.changed()
  }

  /** Signs in with a code sent by email (the web client), instead of Apple or Google. */
  get signsInByEmail() {
    return !!window.codync.account.email
  }

  /** The email sign-in sheet is open. */
  emailSheetOpen = false

  openEmailSignIn() {
    this.emailSheetOpen = true
    this.changed()
  }

  closeEmailSignIn() {
    this.emailSheetOpen = false
    window.codync.account.email?.cancel()
    this.changed()
  }

  async signIn(provider: SignInProvider) {
    if (this.signsInByEmail) return this.openEmailSignIn()
    this.provider = provider
    analytics.track({ event: 'sign_in_started', provider })
    const reason = await window.codync.account.signIn(provider)
    if (reason) analytics.track({ event: 'sign_in_failed', provider, reason })
  }

  async signOut() {
    await window.codync.account.signOut()
  }

  /** The account menu's Delete account, waiting for the user to confirm (`DeleteAccountPrompt`). */
  confirmingDelete = false

  askToDelete(ask = true) {
    this.confirmingDelete = ask
    this.changed()
  }

  /** Deletes the signed-in account; false when it couldn't, and nothing changed. */
  deleteAccount() {
    return window.codync.account.deleteAccount()
  }

  sessionToken() {
    return window.codync.account.token()
  }
}

export const account = new AccountSession()

export function useAccount() {
  return useModel(account)
}
