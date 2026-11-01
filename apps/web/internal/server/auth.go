package server

import (
	"crypto/hmac"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Who may use this server. The browser's device keys are what a computer authorizes (§4); this
// gate only keeps strangers off the page and the bridge. One secret (a generated access key, or a
// password from the environment) signs a person in; a session is an HMAC-signed cookie, so a
// restart keeps people signed in and rotating the secret signs everyone out.

const (
	sessionCookie   = "codync_web_session"
	sessionLifetime = 30 * 24 * time.Hour
	pbkdf2Rounds    = 600_000
	accessFile      = "access.json"
)

// Credential is the stored form of the access secret.
type Credential struct {
	Salt   string `json:"salt"`
	Rounds int    `json:"rounds"`
	Hash   string `json:"hash"`
	// SessionKey signs session cookies; replaced with the secret, which ends every session.
	SessionKey string `json:"sessionKey"`
	// AccessKey is kept when it was generated here (not for a password from the environment),
	// so `codync-web access-key` can show it again; the file is 0600 like any server secret.
	AccessKey string `json:"accessKey,omitempty"`
}

// Matches reports whether `secret` is this credential's secret.
func (c Credential) Matches(secret string) bool {
	a, err := NewAuth(c, func(*http.Request) bool { return false })
	return err == nil && a.check(secret)
}

func hashSecret(secret string, salt []byte, rounds int) ([]byte, error) {
	return pbkdf2.Key(sha256.New, secret, salt, rounds, 32)
}

// NewCredential hashes `secret` with a fresh salt and session key.
func NewCredential(secret string) (Credential, error) {
	salt := make([]byte, 16)
	key := make([]byte, 32)
	_, _ = rand.Read(salt)
	_, _ = rand.Read(key)
	h, err := hashSecret(secret, salt, pbkdf2Rounds)
	if err != nil {
		return Credential{}, err
	}
	enc := base64.RawURLEncoding.EncodeToString
	return Credential{Salt: enc(salt), Rounds: pbkdf2Rounds, Hash: enc(h), SessionKey: enc(key)}, nil
}

// GenerateAccessKey makes a new random access key (128 bits, grouped for reading).
func GenerateAccessKey() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	s := strings.ToLower(base32NoPad(b))
	return s[0:6] + "-" + s[6:12] + "-" + s[12:18] + "-" + s[18:]
}

func base32NoPad(b []byte) string {
	const alphabet = "abcdefghijkmnpqrstuvwxyz23456789" // no l, o, 0, 1
	var out strings.Builder
	var acc, bits uint
	for _, c := range b {
		acc = acc<<8 | uint(c)
		bits += 8
		for bits >= 5 {
			bits -= 5
			out.WriteByte(alphabet[(acc>>bits)&31])
		}
	}
	if bits > 0 {
		out.WriteByte(alphabet[(acc<<(5-bits))&31])
	}
	return out.String()
}

// LoadCredential reads the stored credential, if any.
func LoadCredential(dataDir string) (*Credential, error) {
	data, err := os.ReadFile(filepath.Join(dataDir, accessFile))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var c Credential
	if err := json.Unmarshal(data, &c); err != nil || c.Hash == "" || c.SessionKey == "" || c.Rounds <= 0 {
		return nil, fmt.Errorf("%s is damaged; run `codync-web access-key --rotate`", filepath.Join(dataDir, accessFile))
	}
	return &c, nil
}

// SaveCredential writes the credential (0600, atomically).
func SaveCredential(dataDir string, c Credential) error {
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return err
	}
	data, _ := json.MarshalIndent(c, "", "  ")
	tmp := filepath.Join(dataDir, accessFile+".tmp")
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(dataDir, accessFile))
}

// Auth checks secrets and sessions. A nil *Auth means sign-in is off (--no-auth).
type Auth struct {
	cred       Credential
	sessionKey []byte
	limiter    *loginLimiter
	secure     func(*http.Request) bool
}

func NewAuth(c Credential, secure func(*http.Request) bool) (*Auth, error) {
	key, err := base64.RawURLEncoding.DecodeString(c.SessionKey)
	if err != nil || len(key) < 32 {
		return nil, errors.New("session key is damaged")
	}
	return &Auth{cred: c, sessionKey: key, limiter: newLoginLimiter(), secure: secure}, nil
}

func (a *Auth) check(secret string) bool {
	salt, err1 := base64.RawURLEncoding.DecodeString(a.cred.Salt)
	want, err2 := base64.RawURLEncoding.DecodeString(a.cred.Hash)
	if err1 != nil || err2 != nil {
		return false
	}
	got, err := hashSecret(strings.TrimSpace(secret), salt, a.cred.Rounds)
	return err == nil && subtle.ConstantTimeCompare(got, want) == 1
}

func (a *Auth) sign(payload string) string {
	m := hmac.New(sha256.New, a.sessionKey)
	m.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

// issue sets a new session cookie.
func (a *Auth) issue(w http.ResponseWriter, r *http.Request) {
	nonce := make([]byte, 16)
	_, _ = rand.Read(nonce)
	exp := time.Now().Add(sessionLifetime)
	payload := strconv.FormatInt(exp.Unix(), 10) + "." + base64.RawURLEncoding.EncodeToString(nonce)
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: payload + "." + a.sign(payload), Path: "/", Expires: exp,
		HttpOnly: true, Secure: a.secure(r), SameSite: http.SameSiteStrictMode,
	})
}

func (a *Auth) clear(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, Secure: a.secure(r), SameSite: http.SameSiteStrictMode})
}

// Valid reports whether the request carries a live session.
func (a *Auth) Valid(r *http.Request) bool {
	if a == nil {
		return true
	}
	c, err := r.Cookie(sessionCookie)
	if err != nil {
		return false
	}
	at := strings.LastIndexByte(c.Value, '.')
	if at < 0 {
		return false
	}
	payload, sig := c.Value[:at], c.Value[at+1:]
	if !hmac.Equal([]byte(sig), []byte(a.sign(payload))) {
		return false
	}
	expStr, _, ok := strings.Cut(payload, ".")
	exp, err := strconv.ParseInt(expStr, 10, 64)
	return ok && err == nil && time.Now().Unix() < exp
}

// loginLimiter allows a few attempts per client address and a ceiling for everyone, per window.
type loginLimiter struct {
	mu      sync.Mutex
	window  time.Time
	perIP   map[string]int
	overall int
}

const (
	loginWindow     = 15 * time.Minute
	loginPerIP      = 10
	loginPerWindow  = 100
	loginFailDelay  = 400 * time.Millisecond
	loginBodyLimit  = 4096
	loginSecretMax  = 1024
	loginLimitError = "Too many attempts. Try again in a few minutes."
)

func newLoginLimiter() *loginLimiter { return &loginLimiter{perIP: map[string]int{}} }

func (l *loginLimiter) allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if time.Since(l.window) > loginWindow {
		l.window, l.perIP, l.overall = time.Now(), map[string]int{}, 0
	}
	if l.perIP[ip] >= loginPerIP || l.overall >= loginPerWindow {
		return false
	}
	l.perIP[ip]++
	l.overall++
	return true
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	if s.auth == nil {
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
		return
	}
	if !s.auth.limiter.allow(s.clientIP(r)) {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": loginLimitError})
		return
	}
	var body struct {
		Secret string `json:"secret"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, loginBodyLimit)).Decode(&body); err != nil || len(body.Secret) > loginSecretMax {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Bad request."})
		return
	}
	if !s.auth.check(body.Secret) {
		time.Sleep(loginFailDelay)
		s.log.Warn("failed sign-in", "client", s.clientIP(r))
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "That access key isn't right."})
		return
	}
	s.auth.issue(w, r)
	s.log.Info("signed in", "client", s.clientIP(r))
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if s.auth != nil {
		s.auth.clear(w, r)
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleSession(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]bool{"signedIn": s.auth.Valid(r), "required": s.auth != nil})
}

// clientIP is the peer address, or the proxy's X-Forwarded-For when the proxy is trusted.
func (s *Server) clientIP(r *http.Request) string {
	if s.cfg.TrustProxy {
		if f := r.Header.Get("X-Forwarded-For"); f != "" {
			first, _, _ := strings.Cut(f, ",")
			return strings.TrimSpace(first)
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
