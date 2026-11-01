package server

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"
)

// The WebSocket bridge. A browser can't set headers on a WebSocket, and it can't reach a host on
// this server's LAN or loopback; the bridge does both and nothing else. The browser computes the
// `Codync-Sig` (§5) with its own device key and hands it over; the bridge forwards the channel's
// JSON messages verbatim in both directions. The channel inside is end-to-end encrypted between
// the browser and the host (§6), so the bridge only ever sees ciphertext, routing metadata and the
// handshake's public values.
//
// Messages the bridge itself speaks, never forwarded (channel and relay `t` values never start
// with "bridge."):
//
//	bridge → browser  {"t":"bridge.open"}                 the upstream socket is open
//	bridge → browser  {"t":"bridge.fail","status":N}      the upstream refused (HTTP status, 0 = unreachable); then close 4900
//	browser → bridge  {"t":"bridge.ping"}                 liveness of the browser ↔ bridge leg
//	bridge → browser  {"t":"bridge.pong"}

const (
	// One relay message is at most 1 MiB (§7.6); a frame is a 256 KiB chunk in base64 plus JSON.
	bridgeReadLimit   = 2 << 20
	bridgeDialTimeout = 15 * time.Second
	// Direct hosts ping every 15 s; the bridge pings both legs so a dead one ends the other.
	bridgePingEvery   = 30 * time.Second
	bridgePingTimeout = 15 * time.Second
	closeBridgeFailed = websocket.StatusCode(4900)
)

var bridgePing = []byte(`{"t":"bridge.ping"}`)

func (s *Server) handleBridgeWS(w http.ResponseWriter, r *http.Request) {
	target, kind, err := s.targets.ChannelTarget(r.URL.Query().Get("url"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	sig := r.URL.Query().Get("sig")
	if sig != "" && (kind != TargetRelay || !validSigHeader(sig)) {
		http.Error(w, "bad signature header", http.StatusBadRequest)
		return
	}
	if !s.bridges.acquire() {
		http.Error(w, "too many connections", http.StatusTooManyRequests)
		return
	}
	defer s.bridges.release()

	// Same origin only (the default): another site can't ride a signed-in browser's cookie.
	down, err := websocket.Accept(w, r, &websocket.AcceptOptions{CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		return
	}
	down.SetReadLimit(bridgeReadLimit)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	log := s.log.With("target", target.Host, "kind", kindName(kind))
	header := http.Header{}
	if sig != "" {
		header.Set("Codync-Sig", sig)
	}
	dialCtx, dialCancel := context.WithTimeout(ctx, bridgeDialTimeout)
	up, resp, err := websocket.Dial(dialCtx, target.String(), &websocket.DialOptions{
		HTTPHeader:      header,
		HTTPClient:      s.upstream,
		CompressionMode: websocket.CompressionDisabled,
	})
	dialCancel()
	if err != nil {
		status := 0
		if resp != nil {
			status = resp.StatusCode
		}
		log.Debug("upstream refused", "status", status, "error", err)
		_ = down.Write(ctx, websocket.MessageText, fmt.Appendf(nil, `{"t":"bridge.fail","status":%d}`, status))
		_ = down.Close(closeBridgeFailed, "upstream")
		return
	}
	up.SetReadLimit(bridgeReadLimit)
	if err := down.Write(ctx, websocket.MessageText, []byte(`{"t":"bridge.open"}`)); err != nil {
		_ = up.Close(websocket.StatusGoingAway, "")
		return
	}
	log.Debug("bridged")

	ends := make(chan closeInfo, 2)
	go func() { ends <- pipe(ctx, up, down, nil) }()
	go func() { ends <- pipe(ctx, down, up, func(m []byte) bool { return answerBridgePing(ctx, down, m) }) }()
	go keepAlive(ctx, down, cancel)
	if kind == TargetDirect {
		// A Cloudflare relay keeps its own heartbeat ({"t":"ping"}, §7.6); a host answers pings.
		go keepAlive(ctx, up, cancel)
	}

	var end closeInfo
	select {
	case end = <-ends:
	case <-ctx.Done():
		end = closeInfo{code: websocket.StatusGoingAway}
	}
	// Whichever side ended first: tell the other with the same code (4100 paired, 4003 revoked, …).
	code, reason := end.code, end.reason
	if !forwardable(code) {
		code, reason = websocket.StatusGoingAway, ""
	}
	if end.from == up || end.from == nil {
		_ = down.Close(code, reason)
		_ = up.CloseNow()
	} else {
		_ = up.Close(code, reason)
		_ = down.CloseNow()
	}
}

type closeInfo struct {
	from   *websocket.Conn
	code   websocket.StatusCode
	reason string
}

// pipe copies text messages from `from` to `to` until either side fails. `intercept` may consume a
// message instead of forwarding it.
func pipe(ctx context.Context, from, to *websocket.Conn, intercept func([]byte) bool) closeInfo {
	for {
		typ, msg, err := from.Read(ctx)
		if err != nil {
			code := websocket.CloseStatus(err)
			var ce websocket.CloseError
			reason := ""
			if errors.As(err, &ce) {
				reason = ce.Reason
			}
			return closeInfo{from: from, code: code, reason: reason}
		}
		if typ != websocket.MessageText {
			// The protocol is JSON text only.
			return closeInfo{from: from, code: 4002, reason: "protocolError"}
		}
		if intercept != nil && intercept(msg) {
			continue
		}
		if err := to.Write(ctx, websocket.MessageText, msg); err != nil {
			return closeInfo{from: to, code: websocket.StatusGoingAway}
		}
	}
}

func answerBridgePing(ctx context.Context, down *websocket.Conn, m []byte) bool {
	if !bytes.HasPrefix(m, []byte(`{"t":"bridge.`)) {
		return false
	}
	if bytes.Equal(m, bridgePing) {
		_ = down.Write(ctx, websocket.MessageText, []byte(`{"t":"bridge.pong"}`))
	}
	return true
}

func keepAlive(ctx context.Context, c *websocket.Conn, fail context.CancelFunc) {
	t := time.NewTicker(bridgePingEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			pctx, cancel := context.WithTimeout(ctx, bridgePingTimeout)
			err := c.Ping(pctx)
			cancel()
			if err != nil {
				fail()
				return
			}
		}
	}
}

// forwardable reports whether a close code may be sent on: application codes and normal closure.
func forwardable(code websocket.StatusCode) bool {
	return code == websocket.StatusNormalClosure || code == websocket.StatusGoingAway ||
		code == websocket.StatusInternalError || (code >= 3000 && code <= 4999)
}

// validSigHeader checks the shape of a `Codync-Sig` value (§5) so nothing else rides in a header.
func validSigHeader(v string) bool {
	if len(v) > 512 || !strings.HasPrefix(v, "v=1,") {
		return false
	}
	for _, c := range v {
		if c < 0x21 || c > 0x7e {
			return false
		}
	}
	return true
}

func kindName(k TargetKind) string {
	if k == TargetRelay {
		return "relay"
	}
	return "direct"
}

// bridgeSlots caps concurrent bridged sockets (each costs two connections and two goroutines).
type bridgeSlots chan struct{}

func newBridgeSlots(n int) bridgeSlots { return make(bridgeSlots, n) }

func (b bridgeSlots) acquire() bool {
	select {
	case b <- struct{}{}:
		return true
	default:
		return false
	}
}

func (b bridgeSlots) release() { <-b }
