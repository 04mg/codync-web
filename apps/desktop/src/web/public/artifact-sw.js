// Serves artifacts (a bot's HTML documents) to their frames in the Codync web client.
//
// An artifact's scripts must not run with the app's origin, which holds this browser's device keys
// and its session to codync-web. Each one loads from /artifact/<id> through this worker, with a
// `Content-Security-Policy: sandbox` header that gives the document an opaque origin of its own,
// whatever frame or tab shows it. The HTML comes from the app (read over the end-to-end encrypted
// channel) and stays in this browser; the server never sees it.

const CACHE = 'codync-artifacts-v1'
const KEPT = 50
const SANDBOX = 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

const keyFor = (id) => new URL(`artifact/${id}`, self.registration.scope.replace(/artifact\/$/, '')).toString()

self.addEventListener('message', (event) => {
  const { type, id, html } = event.data ?? {}
  if (type !== 'put' || !/^[0-9a-f-]{36}$/.test(id) || !(html instanceof ArrayBuffer)) return
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE)
    await cache.delete(keyFor(id))
    await cache.put(keyFor(id), new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }))
    // The least recently shown go first (cache keys keep insertion order).
    const keys = await cache.keys()
    for (const old of keys.slice(0, Math.max(0, keys.length - KEPT))) await cache.delete(old)
    event.ports[0]?.postMessage({ ok: true })
  })())
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  const match = /\/artifact\/([0-9a-f-]{36})$/.exec(url.pathname)
  if (!match || event.request.method !== 'GET') return
  event.respondWith((async () => {
    const cached = await (await caches.open(CACHE)).match(keyFor(match[1]))
    const headers = { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': SANDBOX, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }
    if (!cached) return new Response('<!doctype html><meta charset="utf-8"><p style="font: 14px system-ui; color: #888">Open this artifact from its chat again.</p>', { status: 404, headers })
    return new Response(await cached.arrayBuffer(), { headers })
  })())
})
