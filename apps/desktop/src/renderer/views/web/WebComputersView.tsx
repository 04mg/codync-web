import { useState } from 'react'
import type { AccessAsk } from '@shared/ipc'
import { Button, CardSection, IconButton, Spinner } from '../../components/Controls'
import { Dialog, Sheet } from '../../components/Overlay'
import { Spacer, VStack } from '../../components/Stack'
import { Text } from '../../components/Text'
import { useModel } from '../../lib/observable'
import { useTr } from '../../lib/use-language'
import { account, useAccount } from '../../store/account'
import type { BotStore } from '../../store/bot-store'
import type { CloudComputer } from '../../store/cloud'
import { StoreContext, useApp } from '../../store/context'
import { ComputerBadge } from '../ComputerBadge'
import { CodyncVersionRow } from '../settings/ComputersView'
import { relativeDay, SectionHeader, spacedCode, statusText } from '../settings/parts'
import { VoiceChatSettingsView } from '../settings/VoiceChatSettingsView'
import { pairingSheet, useRemote } from './web-model'
import './web.css'

/**
 * The web client's Settings → Computers: the computers this browser reaches over the end-to-end
 * encrypted channel (paired with a link, or approved through the account), adding one, and the
 * account's other computers with "Ask for access" (the iPhone app's Computers screen).
 */
export function WebComputersView() {
  const tr = useTr()
  const app = useApp()
  const remote = useRemote()
  const session = useAccount()
  const cloud = useModel(app.cloud)
  const [forgetting, setForgetting] = useState<BotStore | null>(null)
  if (!remote) return null
  const stores = remote.list().flatMap((c) => app.store(c.id) ?? [])
  const asks = remote.asks()
  const others = cloud.computers.filter((c) => !app.store(c.computerId))

  return (
    <div className="settings-computers">
      <VStack gap={44} className="settings-computers-content">
        <div>
          <SectionHeader title="Computers">
            <IconButton title="Pair a computer" icon="plus" onClick={() => pairingSheet.show()} />
          </SectionHeader>
          {stores.length === 0 ? (
            <Text as="div" size="callout" tone="secondary">{tr('No computers yet. Pair one with the link it shows (codync-host pair).')}</Text>
          ) : null}
          <VStack gap={16}>
            {stores.map((store) => (
              <RemoteComputerCard key={store.computer.id} store={store} source={remote.list().find((c) => c.id === store.computer.id)?.source ?? 'pairing'} onForget={() => setForgetting(store)} />
            ))}
          </VStack>
        </div>

        <div>
          <SectionHeader title="Other computers in your account">
            {session.isSignedIn ? <IconButton title="Refresh" icon="arrow.clockwise" onClick={() => void cloud.refresh()} /> : null}
          </SectionHeader>
          {!session.isConfigured ? (
            <Text as="div" size="callout" tone="secondary">{tr('Account sign-in is off on this server.')}</Text>
          ) : !session.isSignedIn ? (
            <VStack gap={10} align="start">
              <Text as="div" size="callout" tone="secondary">{tr('Sign in to ask your account’s computers for access, without a pairing link.')}</Text>
              <Button kind="secondary" onClick={() => account.openEmailSignIn()}>Sign in with email</Button>
            </VStack>
          ) : others.length === 0 && asks.length === 0 ? (
            <Text as="div" size="callout" tone="secondary">{tr('No other computers in your account yet.')}</Text>
          ) : null}
          <VStack gap={10}>
            {others.map((c) => (
              <AccountComputerRow key={c.computerId} computer={c} ask={asks.find((a) => a.computerId === c.computerId) ?? null} />
            ))}
          </VStack>
        </div>
      </VStack>

      <Dialog
        open={forgetting !== null}
        title={tr('Forget {name} in this browser?').replaceAll('{name}', forgetting?.hostName ?? '')}
        message={tr('Its bots leave this browser. The computer still lists this browser until you revoke it there (Settings → Computers → Authorized devices, or codync-host devices revoke).')}
        actions={forgetting ? [{ title: 'Forget', destructive: true, action: () => void remote.forget(forgetting.computer.id) }] : []}
        onClose={() => setForgetting(null)}
      />
    </div>
  )
}

function routeText(store: BotStore) {
  if (store.connection.kind !== 'online') return null
  return store.hostRoute === 'relay' ? 'through the relay' : store.hostRoute === 'direct' ? 'direct' : null
}

function RemoteComputerCard({ store, source, onForget }: { store: BotStore; source: 'pairing' | 'account'; onForget: () => void }) {
  const tr = useTr()
  useModel(store)
  const [showVoice, setShowVoice] = useState(false)
  const online = store.connection.kind === 'online'
  const route = routeText(store)
  return (
    <>
      <CardSection>
        {[
          <div key="header" className="settings-row">
            <ComputerBadge computer={store.computer} size={26} />
            <VStack grow className="settings-stack">
              <Text size="headline">{store.hostName}</Text>
              <Text size="caption" tone={store.connection.kind === 'unauthorized' ? 'attention' : 'secondary'}>
                {[tr(statusText(store)), route ? tr(route) : null, tr(source === 'account' ? 'approved through your account' : 'paired with a link')].filter(Boolean).join(' · ')}
              </Text>
            </VStack>
            <IconButton title="Voice chat" icon="waveform" selected={showVoice} disabled={!online} onClick={() => setShowVoice((s) => !s)} />
            <IconButton title="Forget in this browser" icon="trash" onClick={onForget} />
          </div>,
          (online || store.isUpdating) && store.hello ? <CodyncVersionRow key="codync" store={store} /> : null,
        ]}
      </CardSection>
      <Sheet open={showVoice} onClose={() => setShowVoice(false)}>
        <StoreContext.Provider value={store}>
          <VoiceChatSettingsView />
        </StoreContext.Provider>
      </Sheet>
    </>
  )
}

function AccountComputerRow({ computer, ask }: { computer: CloudComputer; ask: AccessAsk | null }) {
  const tr = useTr()
  const [error, setError] = useState<string | null>(null)
  const remote = window.codync.remote
  const askNow = () => {
    setError(null)
    void remote?.ask({ computerId: computer.computerId, name: computer.name, signKey: computer.signKey }).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }
  const status = computer.online ? 'Online' : computer.lastSeenAt ? `Offline · seen ${relativeDay(new Date(computer.lastSeenAt))}` : 'Offline'
  return (
    <div className="settings-card settings-appear">
      <div className="settings-row">
        <ComputerBadge computer={{ id: computer.computerId, name: computer.name, signKey: computer.signKey, urls: [], device: computer.device ?? null }} size={22} />
        <div className="settings-stack">
          <Text size="callout" weight="medium">{computer.name}</Text>
          <Text size="caption" tone="secondary">{tr(status)}</Text>
        </div>
        <Spacer />
        {ask && (ask.state === 'asking' || ask.state === 'waitingForCode') ? <Spinner /> : null}
        {ask && ask.state !== 'approved' ? <IconButton title="Stop asking" icon="xmark" onClick={() => remote?.dismissAsk(computer.computerId)} /> : null}
        {!ask || ask.state === 'denied' || ask.state === 'expired' || ask.state === 'failed' ? <Button kind="secondary" onClick={askNow}>Ask for access</Button> : null}
      </div>
      {ask ? <AskLine ask={ask} name={computer.name} /> : null}
      {error ? <Text as="div" size="footnote" tone="attention" role="alert">{error}</Text> : null}
    </div>
  )
}

function AskLine({ ask, name }: { ask: AccessAsk; name: string }) {
  const tr = useTr()
  switch (ask.state) {
    case 'asking':
    case 'waitingForCode':
      return <Text as="div" size="footnote" tone="secondary">{tr('Waiting for {name} to answer…').replaceAll('{name}', name)}</Text>
    case 'confirm':
      return (
        <VStack gap={4}>
          <Text as="div" size="footnote" tone="secondary">{tr('On {name}, check that it shows this code, then approve:').replaceAll('{name}', name)}</Text>
          <span className="web-sas">{spacedCode(ask.sas ?? '')}</span>
        </VStack>
      )
    case 'approved':
      return <Text as="div" size="footnote" tone="secondary">{tr('Approved. Connecting…')}</Text>
    default:
      return <Text as="div" size="footnote" tone="attention">{ask.message ? tr(ask.message) : null}</Text>
  }
}
