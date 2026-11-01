// Package server is the Codync web client's HTTP side: it serves the app (the desktop renderer
// built for the browser) and the two bridges a browser can't do without, all on one port.
package server

import (
	"errors"
	"io/fs"
	"log/slog"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"
)

// Config is how the server runs.
type Config struct {
	// TrustProxy: requests come through a reverse proxy that sets X-Forwarded-For/-Proto.
	TrustProxy bool
	// TLS: the listener itself serves https.
	TLS bool
	// Targets limits what the bridges may reach.
	Targets TargetPolicy
	// MaxBridges caps concurrent bridged sockets.
	MaxBridges int
	Version    string
	// CloudURL is the Codync cloud for accounts; empty turns account sign-in off in the app.
	CloudURL string
	// ClerkPublishableKey is the account provider's public key for that cloud.
	ClerkPublishableKey string
}

// Server serves the UI, the sign-in gate and the bridges.
type Server struct {
	cfg      Config
	auth     *Auth
	ui       fs.FS
	targets  TargetPolicy
	bridges  bridgeSlots
	upstream *http.Client
	log      *slog.Logger
}

// New builds a server. `auth` nil turns sign-in off; `ui` is the built app (index.html, assets/…).
func New(cfg Config, auth *Auth, ui fs.FS, log *slog.Logger) *Server {
	if cfg.MaxBridges <= 0 {
		cfg.MaxBridges = 256
	}
	return &Server{
		cfg: cfg, auth: auth, ui: ui, targets: cfg.Targets, bridges: newBridgeSlots(cfg.MaxBridges), log: log,
		upstream: &http.Client{
			Timeout: proxyTimeout,
			// Never follow a redirect: it could lead anywhere the target checks don't allow.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
	}
}

// Secure reports whether the browser reached us over https (directly or via a trusted proxy).
func (s *Server) Secure(r *http.Request) bool {
	if s.cfg.TLS || r.TLS != nil {
		return true
	}
	return s.cfg.TrustProxy && strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}

// Handler is the whole site.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { writeJSON(w, http.StatusOK, map[string]any{"ok": true, "version": s.cfg.Version}) })
	mux.HandleFunc("GET /auth/session", s.handleSession)
	mux.Handle("POST /auth/login", s.sameOrigin(http.HandlerFunc(s.handleLogin)))
	mux.Handle("POST /auth/logout", s.sameOrigin(http.HandlerFunc(s.handleLogout)))
	mux.Handle("GET /bridge/ws", s.signedIn(http.HandlerFunc(s.handleBridgeWS)))
	mux.Handle("POST /bridge/http", s.sameOrigin(s.signedIn(http.HandlerFunc(s.handleBridgeHTTP))))
	mux.HandleFunc("GET /artifact/", handleArtifactFallback)
	mux.HandleFunc("GET /", s.handleUI)
	return s.headers(mux)
}

// signedIn refuses API requests without a session.
func (s *Server) signedIn(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.auth.Valid(r) {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Sign in first."})
			return
		}
		next.ServeHTTP(w, r)
	})
}

// sameOrigin refuses state-changing requests another site's page sends (on top of SameSite cookies).
func (s *Server) sameOrigin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if origin := r.Header.Get("Origin"); origin != "" {
			u, err := url.Parse(origin)
			if err != nil || !strings.EqualFold(u.Host, r.Host) {
				http.Error(w, "cross-origin request refused", http.StatusForbidden)
				return
			}
		} else if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" && site != "none" {
			http.Error(w, "cross-origin request refused", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// The app's policy: its own scripts only; network to this server and to the voice providers a
// call uses on the user's own key (https/wss, as in the desktop app's policy); artifacts only in
// frames served from this origin by the service worker, which gives them an opaque origin.
const appCSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
	"img-src 'self' data: blob: https:; media-src 'self' blob: data:; font-src 'self' data:; " +
	"connect-src 'self' https: wss:; frame-src 'self'; worker-src 'self'; manifest-src 'self'; " +
	"object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'"

func (s *Server) headers(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		h.Set("Permissions-Policy", "camera=(self), microphone=(self), geolocation=(), payment=(), usb=()")
		if s.Secure(r) {
			h.Set("Strict-Transport-Security", "max-age=31536000")
		}
		next.ServeHTTP(w, r)
	})
}

// handleUI serves the built app: files as they are, any other path the app's page (client routes),
// and the sign-in page to a browser without a session.
func (s *Server) handleUI(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if name == "" {
		name = "index.html"
	}
	if _, err := fs.Stat(s.ui, name); err != nil {
		if path.Ext(name) != "" {
			http.NotFound(w, r)
			return
		}
		name = "index.html"
	}
	// Static files are the open-source app itself; the page that runs it, like the bridges, needs a
	// session, and without one the sign-in page answers instead.
	if name == "index.html" && !s.auth.Valid(r) {
		name = "login.html"
	}
	s.serveFile(w, r, name, appCSP)
}

func (s *Server) serveFile(w http.ResponseWriter, r *http.Request, name, csp string) {
	f, err := s.ui.Open(name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		http.NotFound(w, r)
		return
	}
	h := w.Header()
	if strings.HasSuffix(name, ".html") {
		h.Set("Content-Security-Policy", csp)
		h.Set("Cache-Control", "no-cache")
	} else if strings.HasPrefix(name, "assets/") {
		// Vite names these by content hash.
		h.Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		h.Set("Cache-Control", "no-cache")
	}
	if strings.HasSuffix(name, "sw.js") {
		h.Set("Service-Worker-Allowed", "/")
	}
	rs, ok := f.(interface {
		Read([]byte) (int, error)
		Seek(int64, int) (int64, error)
	})
	if !ok {
		http.Error(w, "unreadable", http.StatusInternalServerError)
		return
	}
	http.ServeContent(w, r, info.Name(), info.ModTime().Truncate(time.Second), rs)
}

// handleArtifactFallback answers artifact frames the browser's artifact service worker didn't serve
// (it wasn't running yet, or the browser bypassed it): never the app itself, always sandboxed.
func handleArtifactFallback(w http.ResponseWriter, _ *http.Request) {
	h := w.Header()
	h.Set("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'")
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNotFound)
	_, _ = w.Write([]byte(`<!doctype html><meta charset="utf-8"><p style="font: 14px system-ui; color: #888">Open this artifact from its chat again.</p>`))
}

// ErrNoUI is returned when the binary was built without the app.
var ErrNoUI = errors.New("this build has no web app inside; build it with `make` in apps/web")
