<div align="center">

<img src="apps/desktop/resources/icon.svg" width="128" alt="Codync icon">

# Codync Web

The [Codync](https://github.com/leepokai/Codync) app in your browser. One self-hosted binary serves the full Codync desktop interface and connects to any `codync-host` over Codync's end-to-end encrypted channel, directly or through the Codync relay. Run it on the same server as your agents and chat with your bots from any browser.

[![Linux x86_64](https://img.shields.io/badge/Linux-x86__64-111111?style=for-the-badge&logo=linux&logoColor=white)](https://github.com/04mg/codync-web/releases/latest/download/codync-web-linux-amd64.tar.gz)
[![Linux arm64](https://img.shields.io/badge/Linux-arm64-111111?style=for-the-badge&logo=linux&logoColor=white)](https://github.com/04mg/codync-web/releases/latest/download/codync-web-linux-arm64.tar.gz)
[![macOS Apple silicon](https://img.shields.io/badge/macOS-Apple%20silicon-111111?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/04mg/codync-web/releases/latest/download/codync-web-darwin-arm64.tar.gz)
[![macOS Intel](https://img.shields.io/badge/macOS-Intel-111111?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/04mg/codync-web/releases/latest/download/codync-web-darwin-amd64.tar.gz)
[![Windows x64](https://img.shields.io/badge/Windows-x64-111111?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/04mg/codync-web/releases/latest/download/codync-web-windows-amd64.zip)
[![Windows arm64](https://img.shields.io/badge/Windows-arm64-111111?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/04mg/codync-web/releases/latest/download/codync-web-windows-arm64.zip)

</div>

## Feature parity

Codync Web is the desktop app's own interface (`apps/desktop/src/renderer`) with a browser bridge in place of Electron. Setup, flags and security model: [apps/web/README.md](apps/web/README.md).

**Works in the browser**

| Area | |
| --- | --- |
| Chat | Bots and group chats, streaming replies, thinking and tool steps, permission cards (allow once, always, deny), queued messages, replies, reactions, history, search, drafts per bot |
| Bots | New bot, profile editor (agent, model, workspace, permissions, connectors, skills), sections, pin, hide, lead bot, delete |
| Computers | Several computers at once, grouped in the sidebar, each over its own encrypted channel; direct route when reachable, else the Codync relay or a private relay |
| Pairing | `codync-host pair` link (or the desktop app's *Copy pairing link*), pasted or opened as `…/#pair=<link>` |
| Offline | Messages to an offline computer wait in the relay's encrypted mailbox and arrive when it's back |
| Access | Revocation on the computer takes effect at once; the browser is listed there as its own device |
| Account | Sign-in with an emailed code, the account's computers, *Ask for access* with the 6-digit code check |
| Files | Attach and upload files, download what bots share |
| Artifacts | Bots' HTML documents in a sandboxed origin, open in a new tab |
| Extensions | Marketplace, skills, connectors, agent setup terminal, routines |
| Other | Usage limits, voice calls with your OpenAI or Gemini key, host version and *Update* button, light/dark theme, text size, languages, tab badge and browser notifications, keyboard shortcuts |

**Not in the browser**

| Missing | Why / instead |
| --- | --- |
| Sign in with Apple or Google, creating an account | Their redirect returns to the native apps only; sign in with an emailed code to an existing account |
| Managing a computer's own host: install, pairing other devices, authorized devices, adding it to the account, relay settings, approving access requests, Network, computer access, remote screen agent | The host only allows these from the computer itself (loopback); use the desktop app or `codync-host` there |
| SSH computers | Pair the computer with a link instead |
| Importing bots from an export file | Run `codync-host import` on the computer |
| On-device speech, voice input shortcut, notch island, menu bar, open at login, in-app updates | Desktop-only; calls use cloud voice on your key, updates come as new releases |
| Push notifications with the tab closed | Notifications show while the tab is open |
| Scanning a QR code | Paste the pairing link |
| Connector sign-in callback | After signing in, paste the final page's address back into Codync |
