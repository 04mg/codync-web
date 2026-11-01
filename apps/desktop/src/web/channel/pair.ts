// Pairing over the channel (§4.1): a channel in pairing mode, whose one request is `pair`; the host
// answers, then closes with 4100 and the device connects normally from then on.

import type { DeviceSigner } from './crypto.ts'
import type { ChannelComputer, Pairing } from './pairing.ts'
import type { SocketEnvironment } from './socket.ts'
import { ChannelError, ChannelTransport } from './transport.ts'

/** The platform this client pairs as: hosts accept ios, macos or android; a browser is a desktop-class client. */
export const PAIR_PLATFORM = 'macos'

export async function pair(p: Pairing, device: DeviceSigner, env: SocketEnvironment, name: string, allowLocalCloud = false): Promise<ChannelComputer> {
  const channel = new ChannelTransport({ computer: p.computer, device, env, pairingCode: p.code, allowLocalCloud }).start()
  try {
    const ok = (await channel.call('pair', { code: p.code, name, platform: PAIR_PLATFORM }, 30_000)) as { computerId?: string; name?: string }
    if (ok.computerId && ok.computerId !== p.computer.id) throw new ChannelError(400, 'That computer answered with another identity.')
    return { ...p.computer, name: ok.name || p.computer.name }
  } finally {
    channel.shutdown()
  }
}
