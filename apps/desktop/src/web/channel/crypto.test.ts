// docs/reference/fixtures/remote-relay-vectors.json against the web client's crypto, field by field.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { b64url, computerIdOf, type DeviceSigner, FrameCodec, Handshake, IdentityChanged, offerId, sasCode, sasCommit, sealMailbox, signRequest, unb64url } from './crypto.ts'

const V = JSON.parse(readFileSync(new URL('../../../../../docs/reference/fixtures/remote-relay-vectors.json', import.meta.url), 'utf8'))
const u = unb64url

/** A seed-backed signer, as the vectors give the device key as a seed (the browser's key is non-extractable). */
function seedSigner(seed: Uint8Array): DeviceSigner {
  return { publicKey: ed25519.getPublicKey(seed), sign: async (m) => ed25519.sign(m, seed) }
}

const device = seedSigner(u(V.keys.deviceSignSeed))
const hostSignPub = u(V.keys.hostSignPub)

test('derives the computer id and device key', () => {
  assert.equal(computerIdOf(hostSignPub), V.keys.computerId)
  assert.equal(b64url(device.publicKey), V.keys.deviceSignPub)
})

test('handshake matches every value and derives the channel keys', async () => {
  const h = V.handshake
  const hs = new Handshake(device, hostSignPub, u(h.deviceEphPriv), u(h.n))
  const hello = await hs.hello(false)
  assert.equal(hello.ek, h.deviceEphPub)
  assert.equal(hello.sig, h.hs1Sig)
  assert.equal(hello.pair, undefined)
  const keys = hs.finish({ ek: h.hostEphPub, sig: h.hs2Sig })
  assert.equal(b64url(keys.d2h), h.kD2H)
  assert.equal(b64url(keys.h2d), h.kH2D)
  assert.equal((await new Handshake(device, hostSignPub).hello(true)).pair, true)
})

test('a welcome signed by another key is an identity change', async () => {
  const h = V.handshake
  const hs = new Handshake(device, hostSignPub, u(h.deviceEphPriv), u(h.n))
  await hs.hello(false)
  const forged = b64url(ed25519.sign(new Uint8Array(32), ed25519.utils.randomSecretKey()))
  assert.throws(() => hs.finish({ ek: h.hostEphPub, sig: forged }), IdentityChanged)
})

test('frames seal and open as the vectors say', () => {
  const keys = { d2h: u(V.handshake.kD2H), h2d: u(V.handshake.kH2D) }
  const d2h = V.frames.find((f: { dir: string }) => f.dir === 'd2h')
  const sealed = new FrameCodec(keys).seal(JSON.parse(d2h.message))
  assert.equal(sealed.length, 1)
  assert.equal(sealed[0]!.d, d2h.d)
  const h2d = V.frames.find((f: { dir: string }) => f.dir === 'h2d')
  assert.deepEqual(new FrameCodec(keys).open({ c: h2d.c, d: h2d.d }), JSON.parse(h2d.message))
  // A replayed or reordered frame closes the channel.
  assert.throws(() => new FrameCodec(keys).open({ c: 1, d: h2d.d }), /expected 0/)
})

test('large messages split into chunks and reassemble', () => {
  const key = new Uint8Array(32).fill(7)
  const sender = new FrameCodec({ d2h: key, h2d: key })
  const receiver = new FrameCodec({ d2h: key, h2d: key })
  const message = { data: 'x'.repeat(700_000) }
  const frames = sender.seal(message)
  assert.equal(frames.length, 3)
  let out: unknown
  for (const f of frames) out = receiver.open(f)
  assert.deepEqual(out, message)
  const fresh = new FrameCodec({ d2h: key, h2d: key }).seal(message)[0]!
  assert.throws(() => new FrameCodec({ d2h: key, h2d: key }, 1000).open(fresh), /too large/)
})

test('mailbox blob matches, and a fresh ephemeral key each time', async () => {
  const m = V.mailbox
  const blob = await sealMailbox(device, hostSignPub, u(V.keys.hostBoxPub), m.clientNonce, m.plaintext, u(m.ephPriv))
  assert.equal(b64url(blob), m.blob)
  const a = await sealMailbox(device, hostSignPub, u(V.keys.hostBoxPub), m.clientNonce, m.plaintext)
  const b = await sealMailbox(device, hostSignPub, u(V.keys.hostBoxPub), m.clientNonce, m.plaintext)
  assert.notDeepEqual(a.subarray(0, 32), b.subarray(0, 32))
  assert.equal(x25519.getPublicKey(u(m.ephPriv)).length, 32)
})

test('Codync-Sig header', async () => {
  const r = V.requestSig
  const url = new URL(`https://${r.authority}${r.pathAndQuery}`)
  assert.equal(`Codync-Sig: ${await signRequest(device, r.method, url, new Uint8Array(), r.ts, r.nonce)}`, r.header)
})

test('pairing offer id and SAS', () => {
  assert.equal(offerId(u(V.pairing.code)), V.pairing.offerId)
  assert.equal(b64url(sasCommit(device.publicKey, u(V.sas.deviceNonce))), V.sas.commit)
  assert.equal(sasCode(hostSignPub, device.publicKey, u(V.sas.deviceNonce), u(V.sas.hostNonce)), V.sas.code)
})
