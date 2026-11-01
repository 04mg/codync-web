// Pairing links (§4.1), read the way the iPhone app reads them (Pairing.swift).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ed25519 } from '@noble/curves/ed25519.js'
import { b64url, computerIdOf, random } from './crypto.ts'
import { channelURL, directURLs, parsePairing, PairingProblem, relayURLs } from './pairing.ts'

const sk = ed25519.getPublicKey(ed25519.utils.randomSecretKey())
const id = computerIdOf(sk)
const link = (extra: Record<string, string> = {}) => {
  const q = new URLSearchParams({ v: '3', name: 'Studio', id, sk: b64url(sk), bk: b64url(random(32)), code: b64url(random(16)), urls: 'http://10.0.0.2:19222,http://10.0.0.2:19222,ftp://x', cloud: 'https://api.codync.dev/', ...extra })
  return `codync://pair?${q}`
}

test('reads a v3 link', () => {
  const p = parsePairing(`  ${link()}\n`)
  assert.equal(p.computer.id, id)
  assert.equal(p.computer.name, 'Studio')
  assert.deepEqual(p.computer.urls, ['http://10.0.0.2:19222'])
  assert.equal(p.computer.cloud, 'https://api.codync.dev')
  assert.equal(p.code.length, 22)
})

test('refuses what the apps refuse', () => {
  assert.throws(() => parsePairing('https://codync.dev'), PairingProblem)
  assert.throws(() => parsePairing(link({ v: '2' })), /Update Codync/)
  assert.throws(() => parsePairing(link({ id: 'AAAAAAAAAAAAAAAAAAAAAA' })), /damaged/)
  assert.throws(() => parsePairing(link({ code: 'short' })), /damaged/)
  assert.throws(() => parsePairing(link({ cloud: 'http://api.codync.dev' })), /damaged/)
  assert.throws(() => parsePairing(link({ urls: '', cloud: '' })), /damaged/)
  assert.equal(parsePairing(link({ cloud: 'http://127.0.0.1:8787' }), { allowLocalCloud: true }).computer.cloud, 'http://127.0.0.1:8787')
})

test('keeps at most 16 direct addresses, once each', () => {
  const many = Array.from({ length: 20 }, (_, i) => `http://10.0.0.${i}:19222`)
  assert.equal(directURLs([...many, many[0]]).length, 16)
})

test('channel and relay addresses', () => {
  assert.equal(channelURL('http://10.0.0.2:19222'), 'ws://10.0.0.2:19222/channel?v=1')
  assert.equal(channelURL('https://mac.ts.net'), 'wss://mac.ts.net/channel?v=1')
  const r = relayURLs('https://api.codync.dev/', id, 'kO-TaDO8k1QnECGLj3N78A')
  assert.equal(r.signed.toString(), `https://api.codync.dev/v1/relay/device/${id}?v=1&pair=kO-TaDO8k1QnECGLj3N78A`)
  assert.equal(r.dial, `wss://api.codync.dev/v1/relay/device/${id}?v=1&pair=kO-TaDO8k1QnECGLj3N78A`)
})
