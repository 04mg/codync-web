import { useState } from 'react'
import { Button, Spinner } from '../../components/Controls'
import { ModalHeader, Sheet } from '../../components/Overlay'
import { VStack } from '../../components/Stack'
import { Text } from '../../components/Text'
import { useTr } from '../../lib/use-language'
import { account, useAccount } from '../../store/account'
import './web.css'

/**
 * The web client's account sign-in: a code sent to the account's email. A browser on a self-hosted
 * address can't receive the Apple or Google redirect the apps use; the code needs no redirect.
 */
export function EmailSignInSheet() {
  const session = useAccount()
  return (
    <Sheet open={session.emailSheetOpen} onClose={() => account.closeEmailSignIn()} width={380}>
      {session.emailSheetOpen ? <EmailSignInForm /> : null}
    </Sheet>
  )
}

function EmailSignInForm() {
  const tr = useTr()
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [step, setStep] = useState<'email' | 'code'>('email')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bridge = window.codync.account.email
  if (!bridge) return null

  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await work()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const send = () => void run(async () => {
    await bridge.start(email)
    // Already signed in (the session was there all along): nothing to verify.
    if (account.isSignedIn) return account.closeEmailSignIn()
    setStep('code')
  })
  const verify = () => void run(async () => {
    await bridge.verify(code)
    account.closeEmailSignIn()
  })
  const enter = (go: () => void) => (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
    e.preventDefault()
    go()
  }

  return (
    <VStack gap={14} className="web-sheet">
      <ModalHeader icon="envelope" title={tr('Sign in to your account')} subtitle={step === 'email' ? tr('We email you a code. Use the email of the account you made in the Codync app.') : tr('Enter the code we sent to {email}.').replaceAll('{email}', email)} />
      {step === 'email' ? (
        <input className="dialog-field" type="email" autoComplete="email" data-autofocus value={email} placeholder={tr('Email')} aria-label={tr('Email')} spellCheck={false}
          onChange={(e) => setEmail(e.target.value)} onKeyDown={enter(send)} disabled={busy} />
      ) : (
        <input className="dialog-field web-code-field" inputMode="numeric" autoComplete="one-time-code" data-autofocus value={code} placeholder="123456" aria-label={tr('Code')}
          onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))} onKeyDown={enter(verify)} disabled={busy} />
      )}
      {error ? <Text as="div" size="footnote" tone="attention" role="alert">{error}</Text> : null}
      <div className="web-sheet-buttons">
        {step === 'code' ? <Button kind="secondary" onClick={() => { setStep('email'); setCode(''); setError(null) }} disabled={busy}>Back</Button> : null}
        {step === 'email' ? (
          <Button onClick={send} disabled={busy || !/^\S+@\S+\.\S+$/.test(email.trim())}>{busy ? <Spinner size={14} /> : tr('Send code')}</Button>
        ) : (
          <Button onClick={verify} disabled={busy || code.length < 6}>{busy ? <Spinner size={14} /> : tr('Sign in')}</Button>
        )}
      </div>
    </VStack>
  )
}
