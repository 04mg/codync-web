# codync-web

The Codync web client in one binary: the Codync desktop app's interface, running in your browser, connected to any `codync-host` over Codync's end-to-end encrypted channel (directly, or through the Codync cloud relay). It is a client only: it runs no agents and no relay.

## Run

```sh
codync-web --listen 127.0.0.1:8080
```

On first start it prints an **access key**; open the address and sign in with it (`codync-web access-key` shows it again, `--rotate` replaces it and signs everyone out). Then pair a computer: run `codync-host pair` on it and paste the `codync://pair?…` link into the app.

Browsers allow the app's cryptography only on **https or localhost**, so pick one:

| Where | How |
| --- | --- |
| Your own machine | `codync-web --listen 127.0.0.1:8080`, open `http://localhost:8080` |
| A VPS, through SSH | the same, then `ssh -L 8080:127.0.0.1:8080 vps` and open `http://localhost:8080` |
| A VPS with a domain | behind Caddy/nginx with TLS: `codync-web --listen 127.0.0.1:8080 --trust-proxy` |
| A VPS, quick | `codync-web --listen 0.0.0.0:8443 --tls-self-signed` (the browser warns once) |
| Your certificate | `--tls-cert fullchain.pem --tls-key privkey.pem` |

One port serves everything: the app, sign-in, the WebSocket bridge (`/bridge/ws`) and the cloud API proxy (`/bridge/http`).

### Options

Every flag also reads an environment variable.

| Flag | Env | Default |
| --- | --- | --- |
| `--listen` | `CODYNC_WEB_LISTEN` | `127.0.0.1:8080` |
| `--data-dir` | `CODYNC_WEB_DATA` | `~/.local/share/codync-web` (Linux), `~/Library/Application Support/codync-web` (macOS), `%AppData%\codync-web` (Windows) |
| `--tls-cert`, `--tls-key` | `CODYNC_WEB_TLS_CERT`, `CODYNC_WEB_TLS_KEY` | off |
| `--tls-self-signed`, `--tls-hosts` | `CODYNC_WEB_TLS_SELF_SIGNED`, `CODYNC_WEB_TLS_HOSTS` | off; covers localhost, the host name and every address |
| `--trust-proxy` | `CODYNC_WEB_TRUST_PROXY` | off |
| `--no-auth` | `CODYNC_WEB_NO_AUTH` | off (sign-in on) |
| — | `CODYNC_WEB_PASSWORD` | a password of your own instead of the generated key (8+ characters) |
| `--cloud-url` | `CODYNC_WEB_CLOUD_URL` | `https://api.codync.dev`; empty turns account sign-in off |
| `--clerk-key` | `CODYNC_WEB_CLERK_KEY` | the Codync cloud's |
| `--allow-local-cloud` | `CODYNC_WEB_ALLOW_LOCAL_CLOUD` | off (development clouds on `http://127.0.0.1`) |
| `--log-level` | `CODYNC_WEB_LOG_LEVEL` | `info` |

### systemd

```ini
[Unit]
Description=Codync web client
After=network-online.target

[Service]
User=codync-web
Environment=CODYNC_WEB_LISTEN=127.0.0.1:8080
Environment=CODYNC_WEB_DATA=/var/lib/codync-web
ExecStart=/usr/local/bin/codync-web --trust-proxy
Restart=always
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

Caddy in front: `codync.example.com { reverse_proxy 127.0.0.1:8080 }`.

`codync-host` runs on its own (`codync-host install`, or `codync-host serve`); codync-web reaches it like a phone does, so it needs no token or file access to the host.

## Security

- **End-to-end encryption ends in the browser.** The handshake (signed ephemeral X25519 → HKDF → ChaCha20-Poly1305) and every message's encryption run in the page; the session keys never leave it. The server only forwards ciphertext: browsers can't set the relay's `Codync-Sig` header on a WebSocket or reach a host on the server's network, so the bridge opens that socket with the signature the browser asked for and passes the channel's messages through unchanged.
- **One device per server.** The server is this Codync Web's device: its Ed25519 device keys (`device.json` in the data directory, readable only by its user) and its paired computers. Browsers ask the server to sign and never get the private keys; every browser that signs in to the server sees the same computers, and a pairing or a forgotten computer reaches open tabs within 30 seconds. Whoever runs the server can use these computers, as they could anyway by changing the app it serves.
- The bridge reaches only the two channel endpoints of the protocol (`ws(s)://…/channel?v=1`, `wss://…/v1/relay/device/{id}?v=1`); the proxy only `https://…/v1/…`. Both need a signed-in session (HttpOnly, SameSite=Strict cookie) and same-origin requests.
- Artifacts (bots' HTML) load through a service worker with a `Content-Security-Policy: sandbox` header: an opaque origin with no access to the app, its keys or its session. Their HTML never reaches the server.
- The Codync account sign-in is kept on the server (`account-session` in the data directory, readable only by its user): the proxy adds it to the account provider's requests and never hands it to a browser, so every browser of this server is signed in to the same account. Signing out anywhere signs out everywhere.
- A computer lists the server as one device (`Codync Web · codync.example.com`), approved there once and revocable there (`codync-host devices revoke`). "Reset all data" forgets the device for every browser.

## Build

Needs Go 1.25+ and Node 22+.

```sh
make            # app + binary for this machine → bin/codync-web
make release    # Linux, macOS, Windows × amd64, arm64 → bin/release
make test
```

Releases take the version of the Codync client they bundle (`apps/desktop/package.json`): codync-web 2.38.0 is the Codync 2.38.0 client, so its number tells which hosts it works with. Tags are `web-vX.Y.Z`, since the upstream `vX.Y.Z` tags already exist in this repository.

The app is the desktop renderer (`apps/desktop/src/renderer`) built with `apps/desktop/vite.web.config.ts` and the browser bridge in `apps/desktop/src/web`; `make ui` writes it to `internal/ui/dist`, which the binary embeds.

End-to-end check against a real host (pairing, relay and direct routes, inner RPC, events):

```sh
cd apps/desktop
CODYNC_WEB_URL=http://127.0.0.1:8080 CODYNC_WEB_KEY=<access key> \
  node --experimental-strip-types src/web/channel/e2e/channel.e2e.ts "$(codync-host pair --json | jq -r .pairingUrl)"
```
