import { Button } from '../../components/Controls'
import { Icon } from '../../components/Icon'
import { VStack } from '../../components/Stack'
import { Text } from '../../components/Text'
import { useTr } from '../../lib/use-language'
import { account, useAccount } from '../../store/account'
import { pairingSheet } from './web-model'
import './web.css'

/** The web client before it has a computer: pair one with a link, or sign in to reach the account's. */
export function FirstComputerView({ manage }: { manage: () => void }) {
  const tr = useTr()
  const session = useAccount()
  return (
    <VStack gap={16} align="center" className="web-first">
      <Icon name="desktopcomputer" size={40} weight="light" color="var(--tertiary)" />
      <Text as="div" size="title2" weight="semibold">{tr('Connect a computer')}</Text>
      <Text as="div" tone="secondary">{tr('Codync runs your bots on a computer with codync-host. Pair this browser with it to chat with its bots from here.')}</Text>
      <Button onClick={() => pairingSheet.show()}>Pair with a link</Button>
      {session.isConfigured ? (
        session.isSignedIn ? (
          <Button kind="secondary" onClick={manage}>Use a computer in your account</Button>
        ) : (
          <Button kind="secondary" onClick={() => account.openEmailSignIn()}>Sign in to use your account's computers</Button>
        )
      ) : null}
    </VStack>
  )
}
