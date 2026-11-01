import { useState } from 'react'
import { Button, Spinner } from '../../components/Controls'
import { ModalHeader, Sheet } from '../../components/Overlay'
import { VStack } from '../../components/Stack'
import { Text } from '../../components/Text'
import { useTr } from '../../lib/use-language'
import { pairingSheet, usePairingSheet } from './web-model'
import './web.css'

/**
 * Pairing this browser with a computer (spec §4.1): the computer shows a one-time link, this browser
 * pairs over the end-to-end encrypted channel and is listed on the computer as a device.
 */
export function PairComputerSheet() {
  const sheet = usePairingSheet()
  return (
    <Sheet open={sheet.open} onClose={() => pairingSheet.close()} width={460}>
      {sheet.open ? <PairForm initial={sheet.link} /> : null}
    </Sheet>
  )
}

function PairForm({ initial }: { initial: string }) {
  const tr = useTr()
  const [link, setLink] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [paired, setPaired] = useState<string | null>(null)
  const remote = window.codync.remote
  if (!remote) return null

  const go = async () => {
    setBusy(true)
    setError(null)
    try {
      setPaired(await remote.pair(link))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (paired) {
    return (
      <VStack gap={14} className="web-sheet">
        <ModalHeader icon="checkmark.circle" title={tr('Paired with {name}').replaceAll('{name}', paired)} subtitle={tr('Its bots appear in the sidebar. The computer lists this browser under its devices.')} />
        <div className="web-sheet-buttons">
          <Button onClick={() => pairingSheet.close()}>Done</Button>
        </div>
      </VStack>
    )
  }

  return (
    <VStack gap={14} className="web-sheet">
      <ModalHeader icon="qrcode" title={tr('Pair a computer')} subtitle={tr('Everything between this browser and the computer is end-to-end encrypted, also through the relay.')} />
      <ol className="web-steps">
        <li>{tr('On the computer, run')} <code>codync-host pair</code>{tr(', or in the Codync app open Settings → Computers → Pair iPhone and copy the pairing link.')}</li>
        <li>{tr('Paste the link here within 10 minutes.')}</li>
      </ol>
      <textarea className="dialog-field web-link-field" data-autofocus value={link} placeholder="codync://pair?v=3&…" aria-label={tr('Pairing link')} spellCheck={false}
        onChange={(e) => setLink(e.target.value)} disabled={busy}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            if (link.trim()) void go()
          }
        }} />
      {error ? <Text as="div" size="footnote" tone="attention" role="alert">{error}</Text> : null}
      <div className="web-sheet-buttons">
        <Button kind="secondary" onClick={() => pairingSheet.close()} disabled={busy}>Cancel</Button>
        <Button onClick={() => void go()} disabled={busy || !link.trim()}>{busy ? <Spinner size={14} /> : tr('Pair')}</Button>
      </div>
    </VStack>
  )
}
