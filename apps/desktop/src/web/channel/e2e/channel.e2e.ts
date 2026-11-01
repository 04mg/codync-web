// End-to-end check of the web client's channel against a real codync-host, through a running
// codync-web's bridge: pairing, then the inner RPC and the events stream, over the cloud relay and
// over the host's direct address. Node 22+:
//
//   CODYNC_WEB_URL=https://127.0.0.1:8080 CODYNC_WEB_KEY=<access key> \
//   node --experimental-strip-types src/web/channel/e2e/channel.e2e.ts '<codync://pair?… link>' [relay|direct|both]
//
// It pairs a fresh device key each run (shown on the computer as "codync-web e2e").

import { ed25519 } from '@noble/curves/ed25519.js'
import { b64url, type DeviceSigner } from '../crypto.ts'
import { pair } from '../pair.ts'
import { parsePairing, type ChannelComputer } from '../pairing.ts'
import type { SocketEnvironment } from '../socket.ts'
import { ChannelTransport, type LinkState } from '../transport.ts'

const base = process.env.CODYNC_WEB_URL ?? 'http://127.0.0.1:8080'
const link = process.argv[2]
const mode = (process.argv[3] ?? 'both') as 'relay' | 'direct' | 'both'
if (!link) throw new Error('usage: channel.e2e.ts <pairing link> [relay|direct|both]')
if (base.startsWith('https:')) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

function check(cond: unknown, what: string): asserts cond {
  if (!cond) throw new Error(`check failed: ${what}`)
  console.log(`  ✓ ${what}`)
}

async function signIn(): Promise<string> {
  const res = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ secret: process.env.CODYNC_WEB_KEY ?? '' }),
  })
  check(res.ok, `signed in to ${base}`)
  const cookie = res.headers.get('set-cookie')?.split(';')[0]
  check(cookie, 'got a session cookie')
  return cookie
}

function environment(cookie: string): SocketEnvironment {
  const url = new URL('/bridge/ws', base)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  // Node's WebSocket (undici) takes headers in its init object.
  const NodeSocket = function (this: unknown, u: string) {
    return new WebSocket(u, { headers: { Cookie: cookie } } as unknown as string[])
  } as unknown as typeof WebSocket
  return { bridgeURL: url.toString(), WebSocket: NodeSocket }
}

function waitState(t: ChannelTransport, ok: (s: LinkState) => boolean, ms = 20_000): Promise<LinkState> {
  if (ok(t.state)) return Promise.resolve(t.state)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out in state ${JSON.stringify(t.state)}`)), ms)
    const off = t.onState((s) => {
      if (!ok(s)) return
      clearTimeout(timer)
      off()
      resolve(s)
    })
  })
}

async function exercise(label: string, computer: ChannelComputer, device: DeviceSigner, env: SocketEnvironment) {
  console.log(`\n▶ ${label}`)
  const t = new ChannelTransport({ computer, device, env }).start()
  const s = await waitState(t, (s) => s.kind === 'ready' || s.kind === 'unauthorized' || (s.kind === 'failed' && t.stopped))
  check(s.kind === 'ready', `channel ready (${JSON.stringify(s)})`)
  const hello = (await t.call('hello', null)) as { name: string; version: string; computerId: string; backends: unknown[] }
  check(hello.computerId === computer.id, `inner hello from ${hello.name}, codync-host ${hello.version}`)
  const events: { type: string }[] = []
  const end = new Promise<void>((resolve) => {
    const cancel = t.subscribe('events', { since: 0, client: 'desktop' }, (ev) => {
      events.push(ev as { type: string })
      if (events.length === 1) setTimeout(() => {
        cancel()
        resolve()
      }, 1500)
    }, () => resolve())
  })
  await end
  check(events[0]?.type === 'hello', `events stream: hello first, then ${events.length - 1} catch-up events`)
  const bots = events.filter((e) => e.type === 'bot').length
  check(bots >= 1, `catch-up carried ${bots} bot(s)`)
  // A ~600 KB request: several 256 KiB frames each way through the bridge.
  const big = 'x'.repeat(600_000)
  try {
    await t.call('listDirs', { path: `/nonexistent-${big}` }, 30_000)
  } catch (error) {
    check((error as { status?: number }).status !== 0, `large multi-frame request answered (${(error as Error).message.slice(0, 60)}…)`)
  }
  t.shutdown()
  return t.computer
}

const cookie = await signIn()
const env = environment(cookie)
const secret = ed25519.utils.randomSecretKey()
const device: DeviceSigner = { publicKey: ed25519.getPublicKey(secret), sign: async (m) => ed25519.sign(m, secret) }
console.log(`device key ${b64url(device.publicKey)}`)

const p = parsePairing(link)
console.log('\n▶ pairing over the relay')
const relayOnly = { ...p, computer: { ...p.computer, urls: mode === 'direct' ? p.computer.urls : [] } }
const paired = await pair(relayOnly, device, env, 'codync-web e2e')
check(paired.id === p.computer.id, `paired with ${paired.name} (${paired.id})`)

let computer: ChannelComputer = { ...paired, urls: [] }
if (mode !== 'direct') computer = { ...(await exercise('relay (Cloudflare)', computer, device, env)), urls: [] }
if (mode !== 'relay') {
  check(p.computer.urls.length > 0, `direct addresses: ${p.computer.urls.join(', ')}`)
  await exercise('direct (host /channel)', { ...computer, urls: p.computer.urls, cloud: null }, device, env)
}
console.log('\nall good')
process.exit(0)
