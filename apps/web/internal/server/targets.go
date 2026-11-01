package server

import (
	"errors"
	"net"
	"net/url"
	"regexp"
	"strings"
)

// TargetKind is what a bridged WebSocket connects to. The bridge only ever reaches the two
// endpoints of the Codync channel protocol (docs/reference/remote-relay.md §7.1, §7.5), never an
// arbitrary URL, so it can't be used as a general proxy.
type TargetKind int

const (
	// TargetDirect is a host's own `/channel?v=1` (LAN, Tailscale, CODYNC_EXTERNAL_URL).
	TargetDirect TargetKind = iota + 1
	// TargetRelay is a cloud relay's device socket `/v1/relay/device/{computerId}?v=1[&pair=…]`.
	TargetRelay
)

var (
	relayPath = regexp.MustCompile(`^/v1/relay/device/[A-Za-z0-9_-]{22}$`)
	offerID   = regexp.MustCompile(`^[A-Za-z0-9_-]{22}$`)
)

// TargetPolicy says which upstreams are allowed beyond the protocol's shape.
type TargetPolicy struct {
	// AllowPlainLoopbackCloud lets a relay or cloud API on http://127.0.0.1 / localhost through
	// (a development cloud); real clouds are https only, as the apps require (§4.1 `cloud`).
	AllowPlainLoopbackCloud bool
}

var errTarget = errors.New("not a Codync channel endpoint")

// ChannelTarget checks a WebSocket URL the browser asks the bridge to open.
func (p TargetPolicy) ChannelTarget(raw string) (*url.URL, TargetKind, error) {
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.Fragment != "" || u.Opaque != "" || u.Host == "" {
		return nil, 0, errTarget
	}
	if u.Scheme != "ws" && u.Scheme != "wss" {
		return nil, 0, errTarget
	}
	q, err := url.ParseQuery(u.RawQuery)
	if err != nil || q.Get("v") != "1" || len(q["v"]) != 1 {
		return nil, 0, errTarget
	}
	switch {
	case u.Path == "/channel":
		// Direct addresses are plain http on a LAN by design: the channel is end-to-end
		// encrypted and the host's identity is checked in the handshake.
		if len(q) != 1 {
			return nil, 0, errTarget
		}
		return u, TargetDirect, nil
	case relayPath.MatchString(u.Path):
		for k, v := range q {
			if (k != "v" && k != "pair") || len(v) != 1 {
				return nil, 0, errTarget
			}
		}
		if pair, ok := q["pair"]; ok && !offerID.MatchString(pair[0]) {
			return nil, 0, errTarget
		}
		if u.Scheme == "ws" && !(p.AllowPlainLoopbackCloud && isLoopbackHost(u.Hostname())) {
			return nil, 0, errTarget
		}
		return u, TargetRelay, nil
	}
	return nil, 0, errTarget
}

// CloudAPITarget checks an HTTPS URL for the cloud's `/v1` API (accounts, access requests) or the
// account provider's Frontend API, which also lives under `/v1`.
func (p TargetPolicy) CloudAPITarget(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.Fragment != "" || u.Opaque != "" || u.Host == "" {
		return nil, errTarget
	}
	if !strings.HasPrefix(u.Path, "/v1/") || strings.Contains(u.Path, "..") {
		return nil, errTarget
	}
	switch u.Scheme {
	case "https":
		return u, nil
	case "http":
		if p.AllowPlainLoopbackCloud && isLoopbackHost(u.Hostname()) {
			return u, nil
		}
	}
	return nil, errTarget
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
