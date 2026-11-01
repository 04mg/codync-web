// Artifacts in the browser: their HTML goes to the artifact service worker (public/artifact-sw.js),
// which serves each one in a sandbox with an opaque origin, as `codync-artifact://` does in the
// desktop app. Nothing leaves the browser.

const base = new URL('.', document.baseURI)
const SCOPE = new URL('artifact/', base).toString()

let registration: Promise<ServiceWorker> | null = null

function worker(): Promise<ServiceWorker> {
  registration ??= (async () => {
    if (!('serviceWorker' in navigator)) throw new Error("This browser can't show artifacts (no service workers).")
    const reg = await navigator.serviceWorker.register(new URL('artifact-sw.js', base), { scope: SCOPE })
    const sw = reg.active ?? reg.waiting ?? reg.installing
    if (!sw) throw new Error("Couldn't start the artifact viewer.")
    if (sw.state !== 'activated') {
      await new Promise<void>((resolve) => {
        const check = () => sw.state === 'activated' && (sw.removeEventListener('statechange', check), resolve())
        sw.addEventListener('statechange', check)
        check()
      })
    }
    return sw
  })()
  registration.catch(() => (registration = null))
  return registration
}

function check(id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid artifact')
}

export const artifacts = {
  async show(id: string, html: Uint8Array) {
    check(id)
    const sw = await worker()
    const copy = html.slice().buffer
    await new Promise<void>((resolve, reject) => {
      const channel = new MessageChannel()
      const timer = setTimeout(() => reject(new Error("The artifact viewer didn't answer.")), 10_000)
      channel.port1.onmessage = () => {
        clearTimeout(timer)
        resolve()
      }
      sw.postMessage({ type: 'put', id, html: copy }, [channel.port2, copy])
    })
  },
  frameURL(id: string, version: number, preview: boolean) {
    return `${SCOPE}${id}?v=${version}${preview ? '&preview' : ''}`
  },
  async openInBrowser(id: string, html: Uint8Array) {
    await artifacts.show(id, html)
    window.open(`${SCOPE}${id}`, '_blank', 'noopener')
  },
}
