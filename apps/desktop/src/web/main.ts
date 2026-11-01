// The Codync web client: the desktop app's renderer in a browser, served by codync-web. The bridge
// (`window.codync`) must exist before any renderer module loads, and it needs the server's settings.
import { loadWebConfig } from './environment'
import { presetWebPreferences } from './preferences'

await loadWebConfig()
presetWebPreferences()
const { installBridge } = await import('./bridge')
installBridge()
await import('../renderer/main')
