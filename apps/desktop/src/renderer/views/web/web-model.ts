import { useEffect, useState } from 'react'
import type { RemoteComputersBridge } from '@shared/ipc'
import { Observable, useModel } from '../../lib/observable'

/** The web client's pairing sheet: open, with a link to start from (a `#pair=` address, say). */
class PairingSheet extends Observable {
  open = false
  link = ''

  show(link = '') {
    this.open = true
    this.link = link
    this.changed()
  }

  close() {
    this.open = false
    this.link = ''
    this.changed()
  }
}

export const pairingSheet = new PairingSheet()

export function usePairingSheet() {
  return useModel(pairingSheet)
}

/** The web client's computers (window.codync.remote), re-rendering on every change; null in the desktop app. */
export function useRemote(): RemoteComputersBridge | null {
  const remote = window.codync.remote ?? null
  const [, bump] = useState(0)
  useEffect(() => remote?.onChange(() => bump((n) => n + 1)), [remote])
  return remote
}

/** `#pair=codync://pair?…` opens the pairing sheet with that link (then leaves the address). */
export function takePairingLinkFromAddress() {
  const hash = new URLSearchParams(location.hash.slice(1))
  const link = hash.get('pair')
  if (!link) return
  history.replaceState(null, '', location.pathname + location.search)
  pairingSheet.show(link)
}
