package server

import (
	"encoding/base64"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// AccountSession is the Codync account this server is signed in to: the account provider's
// (Clerk's) client token, kept in the data directory. The proxy adds it to every request for the
// provider's Frontend API and keeps the rotated one it answers with, so every browser that uses
// this server shares one sign-in and the token never reaches a browser. Each browser still has
// its own device key, so each computer still approves each browser (spec §4.2).
type AccountSession struct {
	path string
	host string

	mu    sync.Mutex
	token string
}

// NewAccountSession loads the saved session for the provider named by `publishableKey`.
func NewAccountSession(dataDir, publishableKey string) (*AccountSession, error) {
	host, err := frontendHost(publishableKey)
	if err != nil {
		return nil, err
	}
	a := &AccountSession{path: filepath.Join(dataDir, "account-session"), host: host}
	data, err := os.ReadFile(a.path)
	switch {
	case err == nil:
		a.token = strings.TrimSpace(string(data))
	case !errors.Is(err, os.ErrNotExist):
		return nil, err
	}
	return a, nil
}

// frontendHost is the publishable key's payload: `pk_live_<base64("host$")>`.
func frontendHost(key string) (string, error) {
	payload := strings.TrimPrefix(strings.TrimPrefix(key, "pk_live_"), "pk_test_")
	raw, err := base64.RawStdEncoding.DecodeString(strings.TrimRight(payload, "="))
	host := strings.TrimSuffix(string(raw), "$")
	if err != nil || host == "" || strings.ContainsAny(host, "/?#@ ") {
		return "", errors.New("not a Clerk publishable key")
	}
	return host, nil
}

// Owns reports whether a request goes to the account provider.
func (a *AccountSession) Owns(u *url.URL) bool {
	return a != nil && strings.EqualFold(u.Host, a.host)
}

// Token is the saved client token ("" before the first request).
func (a *AccountSession) Token() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.token
}

// Rotate keeps the token the provider answered with; empty or bare "Bearer" means signed out.
func (a *AccountSession) Rotate(token string) error {
	token = strings.TrimSpace(token)
	if strings.EqualFold(token, "bearer") {
		token = ""
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if token == a.token {
		return nil
	}
	a.token = token
	if token == "" {
		if err := os.Remove(a.path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(a.path), 0o700); err != nil {
		return err
	}
	tmp := a.path + ".tmp"
	if err := os.WriteFile(tmp, []byte(token), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, a.path)
}
