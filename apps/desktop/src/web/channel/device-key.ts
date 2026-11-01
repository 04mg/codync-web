// This browser's device key (§3.2): one Ed25519 key per browser profile, made with WebCrypto as
// non-extractable and kept in IndexedDB. Script on this origin can ask it to sign but can never
// read the private key, so it can't be copied off the device; clearing the site's data removes it
// (the computers then need pairing again). The cloud and the computers only ever see its public half.

import type { DeviceSigner } from './crypto.ts'

const DB = 'codync-web'
const STORE = 'keys'

export class CryptoUnavailable extends Error {}

/** Signs with a WebCrypto Ed25519 private key. */
export async function webCryptoSigner(pair: CryptoKeyPair): Promise<DeviceSigner> {
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  return {
    publicKey,
    sign: async (message) => new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, message as Uint8Array<ArrayBuffer>)),
  }
}

/** A fresh non-extractable Ed25519 key pair. */
export async function generateDeviceKey(): Promise<CryptoKeyPair> {
  if (!globalThis.crypto?.subtle) {
    throw new CryptoUnavailable('Open Codync over https (or on localhost): browsers only allow its encryption on a secure page.')
  }
  try {
    return (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])) as CryptoKeyPair
  } catch {
    throw new CryptoUnavailable("This browser can't make Ed25519 keys. Update it (Chrome 137, Firefox 129, Safari 17 or newer).")
  }
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error("Couldn't open this browser's storage."))
  })
}

function run<T>(db: IDBDatabase, mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = op(db.transaction(STORE, mode).objectStore(STORE))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error("Couldn't use this browser's storage."))
  })
}

const loaded = new Map<string, Promise<DeviceSigner>>()

/**
 * This browser's device key for an account context (§3.2: `local` for computers paired with a
 * link, one per signed-in account otherwise, so accounts can't be linked through it), made on first use.
 */
export function deviceKey(context = 'local'): Promise<DeviceSigner> {
  const name = `device-key:${context}`
  const cached = loaded.get(name)
  if (cached) return cached
  const loading = (async () => {
    if (!window.isSecureContext) {
      throw new CryptoUnavailable('Open Codync over https (or on localhost): browsers only allow its encryption on a secure page.')
    }
    const db = await open()
    try {
      let pair = await run<CryptoKeyPair | undefined>(db, 'readonly', (s) => s.get(name))
      if (!pair?.privateKey || pair.privateKey.extractable) {
        pair = await generateDeviceKey()
        await run(db, 'readwrite', (s) => s.put(pair, name))
      }
      // Keep the key when the browser is short of space (best effort; it may still ask).
      void navigator.storage?.persist?.().catch(() => false)
      return await webCryptoSigner(pair)
    } finally {
      db.close()
    }
  })()
  loaded.set(name, loading)
  loading.catch(() => loaded.delete(name))
  return loading
}

/** Forgets every device key ("Reset all data", signing out): their computers have to authorize this browser again. */
export async function deleteDeviceKeys(context?: string) {
  const db = await open()
  try {
    if (context) {
      loaded.delete(`device-key:${context}`)
      await run(db, 'readwrite', (s) => s.delete(`device-key:${context}`))
    } else {
      loaded.clear()
      await run(db, 'readwrite', (s) => s.clear())
    }
  } finally {
    db.close()
  }
}
