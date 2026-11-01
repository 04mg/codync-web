import { useState } from 'react'
import { Button, CardSection, Switch, ValueRow } from '../../components/Controls'
import { Text } from '../../components/Text'
import { useTr } from '../../lib/use-language'

/** The web client's General settings in place of the desktop's System ones: notifications, keys, this server. */
export function BrowserSettings() {
  const tr = useTr()
  const browser = window.codync.browser
  const [notify, setNotify] = useState(() => browser?.notifications.enabled() ?? false)
  if (!browser) return null
  return (
    <>
      <CardSection title="Browser" footer={browser.notifications.supported ? 'While this tab is in the background: a bot needs you, finished or failed.' : "This browser doesn't show notifications."}>
        <Switch on={notify} disabled={!browser.notifications.supported} onChange={(on) => void browser.notifications.set(on).then(setNotify)}>
          Notifications
        </Switch>
        {browser.shortcuts.map((s) => (
          <ValueRow key={s.title} label={s.title}>
            <Text tone="secondary" tabular>{s.keys}</Text>
          </ValueRow>
        ))}
      </CardSection>
      <CardSection title="Codync Web" footer={tr('Your device keys stay in this browser. Clearing its site data means pairing your computers again.')}>
        <ValueRow label="Server">
          <Text tone="secondary" tabular>{browser.serverVersion}</Text>
        </ValueRow>
        {browser.signOut ? (
          <ValueRow label="Session">
            <Button kind="secondary" onClick={() => void browser.signOut?.()}>Sign out of this server</Button>
          </ValueRow>
        ) : null}
      </CardSection>
    </>
  )
}
