package server

import "testing"

func TestChannelTarget(t *testing.T) {
	p := TargetPolicy{}
	ok := []struct {
		url  string
		kind TargetKind
	}{
		{"ws://192.168.1.4:19222/channel?v=1", TargetDirect},
		{"wss://mac.tailnet.ts.net/channel?v=1", TargetDirect},
		{"wss://api.codync.dev/v1/relay/device/01R_3aRSnm6-Qu0vDIzizA?v=1", TargetRelay},
		{"wss://api.codync.dev/v1/relay/device/01R_3aRSnm6-Qu0vDIzizA?v=1&pair=kO-TaDO8k1QnECGLj3N78A", TargetRelay},
	}
	for _, c := range ok {
		_, kind, err := p.ChannelTarget(c.url)
		if err != nil || kind != c.kind {
			t.Errorf("%s: got kind %d err %v, want %d", c.url, kind, err, c.kind)
		}
	}
	bad := []string{
		"http://192.168.1.4:19222/channel?v=1",                                      // not a WebSocket
		"ws://192.168.1.4:19222/api/hello?v=1",                                      // not the channel
		"ws://192.168.1.4:19222/channel",                                            // no version
		"ws://192.168.1.4:19222/channel?v=1&x=2",                                    // extra query
		"ws://user:pw@192.168.1.4:19222/channel?v=1",                                // credentials
		"ws://api.codync.dev/v1/relay/device/01R_3aRSnm6-Qu0vDIzizA?v=1",            // relay without TLS
		"wss://api.codync.dev/v1/relay/device/short?v=1",                            // bad computer id
		"wss://api.codync.dev/v1/relay/host?v=1",                                    // the host's socket
		"wss://api.codync.dev/v1/relay/device/01R_3aRSnm6-Qu0vDIzizA?v=1&pair=../x", // bad offer
		"wss://api.codync.dev/v1/relay/device/01R_3aRSnm6-Qu0vDIzizA/../x?v=1",
		"",
	}
	for _, u := range bad {
		if _, _, err := p.ChannelTarget(u); err == nil {
			t.Errorf("%s: accepted", u)
		}
	}
	if _, _, err := (TargetPolicy{AllowPlainLoopbackCloud: true}).ChannelTarget("ws://127.0.0.1:8787/v1/relay/device/01R_3aRSnm6-Qu0vDIzizA?v=1"); err != nil {
		t.Errorf("local dev relay refused: %v", err)
	}
}

func TestCloudAPITarget(t *testing.T) {
	p := TargetPolicy{}
	for _, u := range []string{"https://api.codync.dev/v1/computers", "https://clerk.codync.dev/v1/client?_is_native=true"} {
		if _, err := p.CloudAPITarget(u); err != nil {
			t.Errorf("%s refused: %v", u, err)
		}
	}
	for _, u := range []string{
		"http://api.codync.dev/v1/computers",       // plain http
		"https://api.codync.dev/admin",             // not /v1
		"https://api.codync.dev/v1/../admin",       // traversal
		"http://169.254.169.254/v1/latest",         // metadata over http
		"https://user@api.codync.dev/v1/computers", // credentials
		"http://127.0.0.1:19222/v1/x",              // loopback without the dev flag
	} {
		if _, err := p.CloudAPITarget(u); err == nil {
			t.Errorf("%s accepted", u)
		}
	}
}

func TestValidSigHeader(t *testing.T) {
	if !validSigHeader("v=1,kid=abc,ts=1,nonce=n,sig=s") {
		t.Error("valid header refused")
	}
	for _, v := range []string{"v=2,kid=a", "v=1,kid=a\r\nX-Evil: 1", "v=1, kid=a"} {
		if validSigHeader(v) {
			t.Errorf("%q accepted", v)
		}
	}
}
