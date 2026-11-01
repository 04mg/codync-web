// A pairing link (§4.1), as the iPhone app reads it (apps/ios/Kit/Sources/CodyncKit/Client/Pairing.swift):
// `codync://pair?v=3&name=…&id=<computerId>&sk=…&bk=…&code=…&urls=a,b&cloud=…`

import { computerIdOf, unb64url } from './crypto.ts'

/** A computer this browser can reach: its pinned identity and where to find it. Same shape as `Computer`. */
export interface ChannelComputer {
  id: string
  name: string
  /** Pinned Ed25519 public key (b64url): the handshake is checked against it. */
  signKey: string
  /** Pinned X25519 key for the mailbox, only ever from the pairing link or an inner `hello` (§3.3). */
  boxKey?: string | null
  /** Direct addresses (`http://ip:port`), best first. */
  urls: string[]
  /** The relay's base URL (`https://…`). */
  cloud?: string | null
  device?: string | null
  color?: string | null
}

export interface Pairing {
  computer: ChannelComputer
  code: string
}

export class PairingProblem extends Error {}

/** Phones keep at most this many direct addresses, best first. */
export const MAX_URLS = 16

const SCHEMES = new Set(['codync:', 'codync-dev:'])

export function parsePairing(text: string, options: { allowLocalCloud?: boolean } = {}): Pairing {
  let url: URL
  try {
    url = new URL(text.trim())
  } catch {
    throw new PairingProblem("That isn't a Codync pairing code.")
  }
  // `codync://pair?…` parses with host "pair" (or, in some engines, path "//pair").
  const target = url.host || url.pathname.replace(/^\/+/, '')
  if (!SCHEMES.has(url.protocol) || target !== 'pair') throw new PairingProblem("That isn't a Codync pairing code.")
  const q = url.searchParams
  if (q.get('v') !== '3') throw new PairingProblem('Update Codync on your computer, then show a new pairing code.')
  const invalid = new PairingProblem('This pairing code is damaged. Show a new one on your computer.')
  const id = q.get('id') ?? ''
  const sk = q.get('sk') ?? ''
  const bk = q.get('bk') ?? ''
  const code = q.get('code') ?? ''
  try {
    if (unb64url(sk).length !== 32 || unb64url(bk).length !== 32 || unb64url(code).length !== 16) throw invalid
    if (computerIdOf(unb64url(sk)) !== id) throw invalid
  } catch {
    throw invalid
  }
  const urls = directURLs((q.get('urls') ?? '').split(','))
  let cloud: string | null = null
  const rawCloud = q.get('cloud')
  if (rawCloud) {
    if (!isCloudURL(rawCloud, options.allowLocalCloud)) throw invalid
    cloud = rawCloud.replace(/\/+$/, '')
  }
  if (!urls.length && !cloud) throw invalid
  return { computer: { id, name: q.get('name') || 'My computer', signKey: sk, boxKey: bk, urls, cloud }, code }
}

/** Valid direct addresses, once each, the best `MAX_URLS`. */
export function directURLs(urls: unknown[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const u of urls) {
    if (typeof u !== 'string' || !isDirectURL(u) || seen.has(u)) continue
    seen.add(u)
    out.push(u)
    if (out.length === MAX_URLS) break
  }
  return out
}

function isDirectURL(s: string) {
  try {
    const u = new URL(s)
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname
  } catch {
    return false
  }
}

/** https only; a development cloud on the loopback when allowed. */
export function isCloudURL(s: string, allowLocal = false) {
  try {
    const u = new URL(s)
    if (!u.hostname) return false
    if (u.protocol === 'https:') return true
    return allowLocal && u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname)
  } catch {
    return false
  }
}

/** `http://h:p` → `ws://h:p/channel?v=1`, `https://h` → `wss://h/channel?v=1` (§7.5). */
export function channelURL(base: string): string | null {
  try {
    const u = new URL(base)
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
    u.pathname = '/channel'
    u.search = '?v=1'
    u.hash = ''
    return u.toString()
  } catch {
    return null
  }
}

/** `GET {cloud}/v1/relay/device/{computerId}?v=1[&pair=<offerId>]` as https (what is signed) and wss (what is dialed). */
export function relayURLs(cloud: string, computerId: string, offer: string | null): { signed: URL; dial: string } {
  const signed = new URL(`v1/relay/device/${computerId}`, `${cloud.replace(/\/+$/, '')}/`)
  signed.search = offer ? `?v=1&pair=${offer}` : '?v=1'
  const dial = new URL(signed)
  dial.protocol = signed.protocol === 'http:' ? 'ws:' : 'wss:'
  return { signed, dial: dial.toString() }
}
