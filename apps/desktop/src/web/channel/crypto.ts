// The device half of the relay protocol's cryptography (docs/reference/remote-relay.md §5, §6),
// ported from the vector-checked reference in cloud/test/ref.ts. The device key never appears
// here: signing goes through a `DeviceSigner`, which in the browser is a non-extractable
// WebCrypto key (device-key.ts).

import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { expand, extract } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'

const enc = new TextEncoder()
const dec = new TextDecoder()

/** The device's long-term Ed25519 key: its public half and a signer that never exposes the private half. */
export interface DeviceSigner {
  readonly publicKey: Uint8Array
  sign(message: Uint8Array): Promise<Uint8Array>
}

// MARK: encoding (§1: base64url without padding)

export function b64url(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function unb64url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('not base64url')
  return Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

export const random = (n: number) => crypto.getRandomValues(new Uint8Array(n))

function u64be(c: number) {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, BigInt(c))
  return out
}

function dh(priv: Uint8Array, pub: Uint8Array): Uint8Array {
  const ss = x25519.getSharedSecret(priv, pub)
  if (ss.every((b) => b === 0)) throw new Error('all-zero shared secret')
  return ss
}

// MARK: identity (§1)

export const cidRaw = (hostSignPub: Uint8Array) => sha256(hostSignPub).subarray(0, 16)
export const computerIdOf = (hostSignPub: Uint8Array) => b64url(cidRaw(hostSignPub))
export const verify = (pub: Uint8Array, sig: Uint8Array, msg: Uint8Array) => {
  try {
    return ed25519.verify(sig, msg, pub)
  } catch {
    return false
  }
}

// MARK: Codync-Sig (§5)

export function sigCanonical(method: string, authority: string, pathAndQuery: string, ts: number, nonce: string, body: Uint8Array) {
  return ['codync-sig-v1', method.toUpperCase(), authority.toLowerCase(), pathAndQuery, String(ts), nonce, b64url(sha256(body))].join('\n')
}

/** The `Codync-Sig` header value for a request to `url` (its authority and path + query exactly as sent). */
export async function signRequest(device: DeviceSigner, method: string, url: URL, body: Uint8Array = new Uint8Array(), ts = Date.now(), nonce = b64url(random(16))) {
  const canonical = sigCanonical(method, url.host, `${url.pathname || '/'}${url.search}`, ts, nonce, body)
  const sig = await device.sign(enc.encode(canonical))
  return `v=1,kid=${b64url(device.publicKey)},ts=${ts},nonce=${nonce},sig=${b64url(sig)}`
}

// MARK: handshake (§6.2)

export interface ChannelKeys {
  d2h: Uint8Array
  h2d: Uint8Array
}

export const hs1Input = (cid: Uint8Array, dk: Uint8Array, ekD: Uint8Array, n: Uint8Array) =>
  concat(enc.encode('codync/hs1/v1'), cid, dk, ekD, n)

export const transcriptHash = (cid: Uint8Array, dk: Uint8Array, ekD: Uint8Array, n: Uint8Array, ekH: Uint8Array) =>
  sha256(concat(enc.encode('codync/hs2/v1'), cid, dk, ekD, n, ekH))

export function channelKeys(ekPriv: Uint8Array, peerEk: Uint8Array, th: Uint8Array): ChannelKeys {
  const prk = extract(sha256, dh(ekPriv, peerEk), th)
  return { d2h: expand(sha256, prk, enc.encode('codync/d2h/v1'), 32), h2d: expand(sha256, prk, enc.encode('codync/h2d/v1'), 32) }
}

export class IdentityChanged extends Error {
  constructor() {
    super("This computer's identity changed. Pair it again to keep using it.")
  }
}

/** One handshake attempt: a fresh ephemeral key and nonce, the signed `hello`, then `finish(welcome)`. */
export class Handshake {
  private readonly device: DeviceSigner
  private readonly hostSignPub: Uint8Array
  private readonly ekPriv: Uint8Array
  private readonly ekPub: Uint8Array
  private readonly n: Uint8Array
  private readonly cid: Uint8Array

  /** `ekPriv` and `n` are fixed only by the vector tests. */
  constructor(device: DeviceSigner, hostSignPub: Uint8Array, ekPriv = x25519.utils.randomSecretKey(), n = random(32)) {
    this.device = device
    this.hostSignPub = hostSignPub
    this.ekPriv = ekPriv
    this.ekPub = x25519.getPublicKey(ekPriv)
    this.n = n
    this.cid = cidRaw(hostSignPub)
  }

  async hello(pair: boolean): Promise<Record<string, unknown>> {
    const sig = await this.device.sign(hs1Input(this.cid, this.device.publicKey, this.ekPub, this.n))
    const hello: Record<string, unknown> = { t: 'hello', v: 1, dk: b64url(this.device.publicKey), ek: b64url(this.ekPub), n: b64url(this.n), sig: b64url(sig) }
    if (pair) hello.pair = true
    return hello
  }

  /** Verifies the host's signature with the pinned key; a mismatch means a different (or fake) computer. */
  finish(welcome: { ek?: unknown; sig?: unknown }): ChannelKeys {
    if (typeof welcome.ek !== 'string' || typeof welcome.sig !== 'string') throw new Error('malformed welcome')
    const ekH = unb64url(welcome.ek)
    if (ekH.length !== 32) throw new Error('malformed welcome')
    const th = transcriptHash(this.cid, this.device.publicKey, this.ekPub, this.n, ekH)
    if (!verify(this.hostSignPub, unb64url(welcome.sig), th)) throw new IdentityChanged()
    return channelKeys(this.ekPriv, ekH, th)
  }
}

// MARK: frames (§6.3)

export const CHUNK = 256 * 1024
/** Counters never wrap (§3.5): the channel is replaced well before. */
const COUNTER_LIMIT = 2 ** 32

const frameNonce = (c: number) => concat(new Uint8Array(4), u64be(c))
const frameAad = (c: number) => concat(enc.encode('codync/frame/v1'), u64be(c))

export class FrameError extends Error {
  /** The close code this calls for (§7.6): 4002 protocolError, 4013 tooLarge. */
  readonly closeCode: 4002 | 4013

  constructor(message: string, closeCode: 4002 | 4013) {
    super(message)
    this.closeCode = closeCode
  }
}

export interface Frame {
  t: 'f'
  c: number
  d: string
}

/** Both directions of one channel: counters, 256 KiB chunks and reassembly. */
export class FrameCodec {
  private sendC = 0
  private recvC = 0
  private parts: Uint8Array[] = []
  private size = 0
  private readonly keys: ChannelKeys
  private readonly maxMessage: number

  constructor(keys: ChannelKeys, maxMessage = 16 * 1024 * 1024) {
    this.keys = keys
    this.maxMessage = maxMessage
  }

  /** The sending counter is close to its end: replace the channel (close 4011 rekey). */
  get exhausted() {
    return this.sendC >= COUNTER_LIMIT - 1024
  }

  seal(message: unknown): Frame[] {
    const bytes = enc.encode(JSON.stringify(message))
    const out: Frame[] = []
    for (let at = 0; at === 0 || at < bytes.length; at += CHUNK) {
      const chunk = bytes.subarray(at, at + CHUNK)
      const final = at + CHUNK >= bytes.length
      const c = this.sendC++
      const sealed = chacha20poly1305(this.keys.d2h, frameNonce(c), frameAad(c)).encrypt(concat(new Uint8Array([final ? 0 : 1]), chunk))
      out.push({ t: 'f', c, d: b64url(sealed) })
    }
    return out
  }

  /** The parsed message once its last chunk arrives; throws a `FrameError` on a counter gap, bad tag or oversize. */
  open(frame: { c?: unknown; d?: unknown }): unknown {
    if (frame.c !== this.recvC || typeof frame.d !== 'string') throw new FrameError(`frame counter ${String(frame.c)}, expected ${this.recvC}`, 4002)
    let plain: Uint8Array
    try {
      plain = chacha20poly1305(this.keys.h2d, frameNonce(this.recvC), frameAad(this.recvC)).decrypt(unb64url(frame.d))
    } catch {
      throw new FrameError("a frame didn't decrypt", 4002)
    }
    if (plain[0] !== 0 && plain[0] !== 1) throw new FrameError('bad frame flag', 4002)
    this.recvC++
    const chunk = plain.subarray(1)
    this.size += chunk.length
    if (this.size > this.maxMessage) throw new FrameError('message too large', 4013)
    this.parts.push(chunk)
    if (plain[0] === 1) return undefined
    const text = dec.decode(concat(...this.parts))
    this.parts = []
    this.size = 0
    try {
      return JSON.parse(text)
    } catch {
      throw new FrameError('a message is not JSON', 4002)
    }
  }
}

// MARK: mailbox (§6.4)

/** Seals one mailbox item for an offline host. A fresh ephemeral key every call (MUST: the AEAD nonce is fixed). */
export async function sealMailbox(device: DeviceSigner, hostSignPub: Uint8Array, hostBoxPub: Uint8Array, clientNonce: string, inner: string,
  /** Fixed only by the vector tests. */
  eprv = x25519.utils.randomSecretKey()): Promise<Uint8Array> {
  const cid = cidRaw(hostSignPub)
  const epk = x25519.getPublicKey(eprv)
  const prk = extract(sha256, dh(eprv, hostBoxPub), concat(enc.encode('codync/mbox/v1'), cid, device.publicKey, epk))
  const key = expand(sha256, prk, enc.encode('codync/mbox-key/v1'), 32)
  const ct = chacha20poly1305(key, new Uint8Array(12), concat(device.publicKey, enc.encode(clientNonce))).encrypt(enc.encode(inner))
  const sig = await device.sign(concat(enc.encode('codync/mbox/v1'), cid, epk, ct))
  return concat(epk, sig, ct)
}

// MARK: pairing and access (§4)

export const offerId = (code: Uint8Array) => b64url(sha256(concat(enc.encode('codync/offer/v1'), code)).subarray(0, 16))

export const sasCommit = (dk: Uint8Array, nD: Uint8Array) => sha256(concat(enc.encode('codync/sascommit/v1'), dk, nD))

export function sasCode(hostSignPub: Uint8Array, dk: Uint8Array, nD: Uint8Array, nH: Uint8Array): string {
  const h = sha256(concat(enc.encode('codync/sas/v2'), hostSignPub, dk, nD, nH))
  return String(new DataView(h.buffer, h.byteOffset).getUint32(0) % 1_000_000).padStart(6, '0')
}

export { dec as utf8Decoder, enc as utf8Encoder }
