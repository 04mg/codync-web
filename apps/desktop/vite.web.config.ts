import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// The Codync web client: this renderer with the browser bridge (src/web), embedded in the codync-web
// binary (apps/web). Separate from the Electron build (electron.vite.config.ts) and the website demo
// (vite.demo.config.ts). `npm run build:web` writes apps/web/internal/ui/dist.

/**
 * Electron's appearance setting drives `prefers-color-scheme`; a page can't, so the dark palette in
 * theme.css also applies under `data-appearance="dark"` and not under `data-appearance="light"`
 * (src/web/appearance.ts sets the attribute).
 */
const appearanceAttribute: Plugin = {
  name: 'codync-web-appearance',
  enforce: 'pre',
  transform(code, id) {
    if (!id.endsWith('/styles/theme.css')) return null
    const head = '@media (prefers-color-scheme: dark) {'
    const start = code.indexOf(head)
    if (start < 0) throw new Error('theme.css has no dark palette block')
    let depth = 0
    let end = start + head.length - 1
    for (; end < code.length; end++) {
      if (code[end] === '{') depth++
      else if (code[end] === '}' && --depth === 0) break
    }
    const inner = code.slice(start + head.length, end)
    if (!/^\s*:root\s*\{[^{}]*\}\s*$/.test(inner)) throw new Error('theme.css dark block changed shape; update vite.web.config.ts')
    const system = inner.replace(':root', ':root:not([data-appearance="light"])')
    const forced = inner.replace(':root', ':root[data-appearance="dark"]')
    return `${code.slice(0, start)}${head}${system}}\n${forced}${code.slice(end + 1)}`
  },
}

/** The app icon, the favicon and the web app manifest, from the desktop app's resources. */
const webAssets: Plugin = {
  name: 'codync-web-assets',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'icon.png', source: readFileSync(resolve('resources/icon.png')) })
    this.emitFile({ type: 'asset', fileName: 'favicon.svg', source: readFileSync(resolve('resources/icon.svg')) })
    this.emitFile({
      type: 'asset',
      fileName: 'manifest.webmanifest',
      source: JSON.stringify({
        name: 'Codync',
        short_name: 'Codync',
        description: 'Your coding agents as teammates, from any browser.',
        start_url: './',
        scope: './',
        display: 'standalone',
        background_color: '#070707',
        theme_color: '#070707',
        icons: [{ src: 'icon.png', sizes: '1024x1024', type: 'image/png', purpose: 'any' }],
      }, null, 2),
    })
  },
}

export default defineConfig({
  root: resolve('src/web'),
  publicDir: resolve('src/web/public'),
  // Relative, so the app also works behind a reverse proxy under a sub-path.
  base: './',
  resolve: { alias: { '@shared': resolve('src/shared') } },
  plugins: [react(), appearanceAttribute, webAssets],
  build: {
    outDir: resolve('../web/internal/ui/dist'),
    emptyOutDir: true,
    // Top-level await in src/web/main.ts.
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    // Every browser it supports preloads modules itself; no polyfill chunk.
    modulePreload: { polyfill: false },
    rollupOptions: { input: { index: resolve('src/web/index.html'), login: resolve('src/web/login.html') } },
  },
})
