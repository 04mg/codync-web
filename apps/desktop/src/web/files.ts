// Files in the browser: picking them for a message, the clipboard's images, and saving what a bot
// shared (downloaded in pieces over the channel, then handed to the browser as one download).

import type { PickedFile } from '@shared/ipc'
import type { SharedFile } from '@shared/models'

export function pickFiles(): Promise<PickedFile[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.style.display = 'none'
    let done = false
    const finish = async () => {
      if (done) return
      done = true
      input.remove()
      const files = [...(input.files ?? [])]
      resolve(await Promise.all(files.map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) }))))
    }
    input.addEventListener('change', () => void finish())
    input.addEventListener('cancel', () => void finish())
    document.body.append(input)
    input.click()
  })
}

/** Images on the clipboard (the composer reads pasted files itself; this covers a copied screenshot). */
export async function readClipboardFiles(): Promise<PickedFile[]> {
  try {
    const items = await navigator.clipboard.read()
    const out: PickedFile[] = []
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith('image/'))
      if (!type) continue
      const blob = await item.getType(type)
      out.push({ name: `Pasted image.${type.split('/')[1] ?? 'png'}`, data: new Uint8Array(await blob.arrayBuffer()) })
    }
    return out
  } catch {
    // No permission, or nothing readable: the paste event's own files still arrive.
    return []
  }
}

/** Saves `data` as a download named `name`. */
export function saveBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** Downloads in progress: pieces written in order, saved as one file at the end. */
const downloads = new Map<string, { name: string; parts: Uint8Array[]; size: number }>()

export const files = {
  async begin(file: SharedFile): Promise<string | null> {
    const id = crypto.randomUUID()
    downloads.set(id, { name: file.name, parts: [], size: 0 })
    return id
  },
  async write(id: string, offset: number, data: Uint8Array) {
    const d = downloads.get(id)
    if (!d) throw new Error('This download was cancelled.')
    if (offset !== d.size) throw new Error('A piece of the file arrived out of order.')
    d.parts.push(data.slice())
    d.size += data.length
  },
  async finish(id: string) {
    const d = downloads.get(id)
    if (!d) throw new Error('This download was cancelled.')
    downloads.delete(id)
    saveBlob(d.name, new Blob(d.parts as BlobPart[]))
  },
  async cancel(id: string) {
    downloads.delete(id)
  },
}
