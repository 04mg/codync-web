package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/coder/websocket"
)

var testUI = fstest.MapFS{
	"index.html":           {Data: []byte("<!doctype html><title>app</title>")},
	"login.html":           {Data: []byte("<!doctype html><title>login</title>")},
	"assets/app-1.js":      {Data: []byte("console.log(1)")},
	"artifact-sw.js":       {Data: []byte("// sw")},
	"manifest.webmanifest": {Data: []byte("{}")},
}

func testServer(t *testing.T, secret string) (*httptest.Server, *Server) {
	t.Helper()
	cred, err := NewCredential(secret)
	if err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	s := New(Config{Targets: TargetPolicy{AllowPlainLoopbackCloud: true}, Version: "test"}, nil, testUI, log)
	auth, err := NewAuth(cred, s.Secure)
	if err != nil {
		t.Fatal(err)
	}
	s.auth = auth
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	return ts, s
}

func login(t *testing.T, ts *httptest.Server, secret string) (*http.Response, string) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/auth/login", strings.NewReader(`{"secret":"`+secret+`"}`))
	req.Header.Set("Origin", ts.URL)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	cookie := ""
	for _, c := range res.Cookies() {
		if c.Name == sessionCookie {
			cookie = c.Name + "=" + c.Value
			if !c.HttpOnly || c.SameSite != http.SameSiteStrictMode {
				t.Errorf("session cookie isn't HttpOnly + SameSite=Strict")
			}
		}
	}
	return res, cookie
}

func get(t *testing.T, url, cookie string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, url, nil)
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func body(res *http.Response) string {
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return string(b)
}

func TestSignInGate(t *testing.T) {
	ts, _ := testServer(t, "correct-horse")
	if b := body(get(t, ts.URL+"/", "")); !strings.Contains(b, "login") {
		t.Errorf("signed out: got %q, want the sign-in page", b)
	}
	if res := get(t, ts.URL+"/assets/app-1.js", ""); res.StatusCode != 200 {
		t.Errorf("static asset: %d", res.StatusCode)
	}
	res := get(t, ts.URL+"/bridge/ws?url=x", "")
	if res.StatusCode != http.StatusUnauthorized {
		t.Errorf("bridge without a session: %d", res.StatusCode)
	}
	if res, _ := login(t, ts, "wrong"); res.StatusCode != http.StatusUnauthorized {
		t.Errorf("wrong secret: %d", res.StatusCode)
	}
	res, cookie := login(t, ts, "correct-horse")
	if res.StatusCode != 200 || cookie == "" {
		t.Fatalf("sign-in failed: %d", res.StatusCode)
	}
	if b := body(get(t, ts.URL+"/", cookie)); !strings.Contains(b, "app") {
		t.Errorf("signed in: got %q, want the app", b)
	}
	// Any client route is the app; a missing file is a 404, not the app.
	if b := body(get(t, ts.URL+"/some/route", cookie)); !strings.Contains(b, "app") {
		t.Errorf("client route: %q", b)
	}
	if res := get(t, ts.URL+"/missing.js", cookie); res.StatusCode != 404 {
		t.Errorf("missing file: %d", res.StatusCode)
	}
	// A forged cookie is refused.
	if b := body(get(t, ts.URL+"/", cookie[:len(cookie)-2]+"xx")); !strings.Contains(b, "login") {
		t.Errorf("forged cookie accepted")
	}
}

func TestSecurityHeaders(t *testing.T) {
	ts, _ := testServer(t, "secret-secret")
	res := get(t, ts.URL+"/", "")
	if csp := res.Header.Get("Content-Security-Policy"); !strings.Contains(csp, "script-src 'self'") || !strings.Contains(csp, "object-src 'none'") {
		t.Errorf("CSP: %q", csp)
	}
	for _, h := range []string{"X-Content-Type-Options", "Referrer-Policy", "Cross-Origin-Opener-Policy"} {
		if res.Header.Get(h) == "" {
			t.Errorf("missing %s", h)
		}
	}
	art := get(t, ts.URL+"/artifact/0b0e1d6e-8a4a-4a43-9c55-0c2d9b6c6b8e", "")
	if !strings.HasPrefix(art.Header.Get("Content-Security-Policy"), "sandbox") || strings.Contains(body(art), "<title>app") {
		t.Error("an artifact path must never serve the app, and always sandboxed")
	}
}

func TestCrossOriginRefused(t *testing.T) {
	ts, _ := testServer(t, "secret-secret")
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/auth/login", strings.NewReader(`{"secret":"secret-secret"}`))
	req.Header.Set("Origin", "https://evil.example")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusForbidden {
		t.Errorf("cross-origin login: %d", res.StatusCode)
	}
}

func TestLoginRateLimit(t *testing.T) {
	ts, _ := testServer(t, "secret-secret")
	limited := false
	for i := 0; i < loginPerIP+1; i++ {
		res, _ := login(t, ts, "nope")
		if res.StatusCode == http.StatusTooManyRequests {
			limited = true
			break
		}
	}
	if !limited {
		t.Error("no rate limit on failed sign-ins")
	}
}

// A fake host /channel: it echoes text messages and closes with 4100 when told to, and records the
// Codync-Sig header it was dialed with.
func fakeUpstream(t *testing.T, sawSig *string) *httptest.Server {
	t.Helper()
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*sawSig = r.Header.Get("Codync-Sig")
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		for {
			_, m, err := c.Read(context.Background())
			if err != nil {
				return
			}
			if string(m) == `{"t":"close"}` {
				_ = c.Close(4100, "paired")
				return
			}
			_ = c.Write(context.Background(), websocket.MessageText, m)
		}
	}))
	t.Cleanup(up.Close)
	return up
}

func dialBridge(t *testing.T, ts *httptest.Server, cookie, target, sig string) *websocket.Conn {
	t.Helper()
	q := url.Values{"url": {target}}
	if sig != "" {
		q.Set("sig", sig)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(ts.URL, "http")+"/bridge/ws?"+q.Encode(), &websocket.DialOptions{HTTPHeader: http.Header{"Cookie": {cookie}}})
	if err != nil {
		t.Fatalf("bridge dial: %v", err)
	}
	return c
}

func read(t *testing.T, c *websocket.Conn) map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, m, err := c.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var v map[string]any
	_ = json.Unmarshal(m, &v)
	return v
}

func TestBridgeForwardsAndCloses(t *testing.T) {
	ts, _ := testServer(t, "secret-secret")
	_, cookie := login(t, ts, "secret-secret")
	var sig string
	up := fakeUpstream(t, &sig)
	target := "ws" + strings.TrimPrefix(up.URL, "http") + "/channel?v=1"
	c := dialBridge(t, ts, cookie, target, "")
	if m := read(t, c); m["t"] != "bridge.open" {
		t.Fatalf("first message %v, want bridge.open", m)
	}
	ctx := context.Background()
	frame := []byte(`{"t":"f","c":0,"d":"AAAA"}`)
	_ = c.Write(ctx, websocket.MessageText, frame)
	if m := read(t, c); m["t"] != "f" {
		t.Errorf("echo %v", m)
	}
	// The bridge answers its own ping and never forwards it.
	_ = c.Write(ctx, websocket.MessageText, []byte(`{"t":"bridge.ping"}`))
	if m := read(t, c); m["t"] != "bridge.pong" {
		t.Errorf("ping answer %v", m)
	}
	// The upstream's close code reaches the browser (4100 paired).
	_ = c.Write(ctx, websocket.MessageText, []byte(`{"t":"close"}`))
	rctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_, _, err := c.Read(rctx)
	if code := websocket.CloseStatus(err); code != 4100 {
		t.Errorf("close code %d, want 4100", code)
	}
}

func TestBridgeSignatureOnlyForRelay(t *testing.T) {
	ts, _ := testServer(t, "secret-secret")
	_, cookie := login(t, ts, "secret-secret")
	var sig string
	up := fakeUpstream(t, &sig)
	host := strings.TrimPrefix(up.URL, "http://")
	// A direct target can't carry a signature.
	res := get(t, ts.URL+"/bridge/ws?"+url.Values{"url": {"ws://" + host + "/channel?v=1"}, "sig": {"v=1,kid=a"}}.Encode(), cookie)
	if res.StatusCode != http.StatusBadRequest {
		t.Errorf("signature on a direct target: %d", res.StatusCode)
	}
	// A relay target carries it upstream as the Codync-Sig header.
	relay := "ws://" + host + "/v1/relay/device/01R_3aRSnm6-Qu0vDIzizA?v=1"
	c := dialBridge(t, ts, cookie, relay, "v=1,kid=abc,ts=1,nonce=n,sig=s")
	if m := read(t, c); m["t"] != "bridge.open" {
		t.Fatalf("got %v", m)
	}
	if sig != "v=1,kid=abc,ts=1,nonce=n,sig=s" {
		t.Errorf("upstream saw Codync-Sig %q", sig)
	}
	_ = c.CloseNow()
}

func TestBridgeReportsUnreachable(t *testing.T) {
	ts, _ := testServer(t, "secret-secret")
	_, cookie := login(t, ts, "secret-secret")
	// Nothing listens there: the bridge reports status 0 (the client then tries the next route).
	c := dialBridge(t, ts, cookie, "ws://127.0.0.1:1/channel?v=1", "")
	m := read(t, c)
	if m["t"] != "bridge.fail" || m["status"] != float64(0) {
		t.Errorf("got %v, want bridge.fail status 0", m)
	}
}

func TestCloudProxy(t *testing.T) {
	ts, _ := testServer(t, "secret-secret")
	_, cookie := login(t, ts, "secret-secret")
	var got http.Header
	cloud := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
		w.Header().Set("Authorization", "rotated")
		w.Header().Set("Set-Cookie", "upstream=1")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer cloud.Close()
	payload, _ := json.Marshal(proxyRequest{Method: "GET", URL: cloud.URL + "/v1/computers", Headers: map[string]string{"Codync-Sig": "v=1,x", "Authorization": "Bearer t", "X-Forwarded-For": "1.2.3.4", "Cookie": "a=b"}})
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/bridge/http", bytes.NewReader(payload))
	req.Header.Set("Cookie", cookie)
	req.Header.Set("Origin", ts.URL)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var answer proxyResponse
	_ = json.NewDecoder(res.Body).Decode(&answer)
	res.Body.Close()
	if answer.Status != 200 || answer.Headers["authorization"] != "rotated" || answer.Headers["set-cookie"] != "" {
		t.Errorf("answer %+v", answer)
	}
	if got.Get("Codync-Sig") != "v=1,x" || got.Get("Authorization") != "Bearer t" {
		t.Errorf("signed headers not forwarded: %v", got)
	}
	if got.Get("X-Forwarded-For") != "" || got.Get("Cookie") != "" {
		t.Errorf("unlisted headers forwarded: %v", got)
	}
	// Not a /v1 path: refused before any request.
	bad, _ := json.Marshal(proxyRequest{Method: "GET", URL: cloud.URL + "/admin"})
	req, _ = http.NewRequest(http.MethodPost, ts.URL+"/bridge/http", bytes.NewReader(bad))
	req.Header.Set("Cookie", cookie)
	res, _ = http.DefaultClient.Do(req)
	if res.StatusCode != http.StatusBadRequest {
		t.Errorf("non-/v1 target: %d", res.StatusCode)
	}
}
