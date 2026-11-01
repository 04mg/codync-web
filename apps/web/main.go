// codync-web: the Codync web client in one binary. It serves the Codync app for the browser and
// the bridges the browser needs to reach codync-host over Codync's end-to-end encrypted channel,
// directly or through the cloud relay. It is a client only: no host, no relay.
package main

import (
	"context"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/04mg/codync-web/apps/web/internal/server"
	"github.com/04mg/codync-web/apps/web/internal/ui"
)

// version is set at build time (-ldflags "-X main.version=…").
var version = "dev"

const usage = `codync-web: the Codync web client

Usage:
  codync-web [serve] [flags]        run the web client (default)
  codync-web access-key [--rotate]  show the access key, or make a new one (signs everyone out)
  codync-web version                print the version

Serve flags (each also reads the environment variable shown):
`

func main() {
	args := os.Args[1:]
	cmd := "serve"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		cmd, args = args[0], args[1:]
	}
	var err error
	switch cmd {
	case "serve":
		err = serve(args)
	case "access-key":
		err = accessKey(args)
	case "version":
		fmt.Println("codync-web", version)
	case "help":
		fmt.Print(usage)
		serveFlags().fs.PrintDefaults()
	default:
		err = fmt.Errorf("unknown command %q (try `codync-web help`)", cmd)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "codync-web:", err)
		os.Exit(1)
	}
}

type options struct {
	fs              *flag.FlagSet
	listen          *string
	dataDir         *string
	tlsCert         *string
	tlsKey          *string
	tlsSelfSigned   *bool
	tlsHosts        *string
	trustProxy      *bool
	noAuth          *bool
	allowLocalCloud *bool
	cloudURL        *string
	clerkKey        *string
	logLevel        *string
}

func env(name, fallback string) string {
	if v, ok := os.LookupEnv(name); ok {
		return v
	}
	return fallback
}

func envBool(name string) bool {
	v := strings.ToLower(os.Getenv(name))
	return v == "1" || v == "true" || v == "yes"
}

func defaultDataDir() string {
	// macOS: ~/Library/Application Support; Windows: %AppData%.
	if runtime.GOOS != "linux" {
		if d, err := os.UserConfigDir(); err == nil {
			return filepath.Join(d, "codync-web")
		}
	}
	if d := os.Getenv("XDG_DATA_HOME"); d != "" {
		return filepath.Join(d, "codync-web")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ".codync-web"
	}
	return filepath.Join(home, ".local", "share", "codync-web")
}

func serveFlags() options {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	return options{
		fs:              fs,
		listen:          fs.String("listen", env("CODYNC_WEB_LISTEN", "127.0.0.1:8080"), "address and port to serve on (CODYNC_WEB_LISTEN)"),
		dataDir:         fs.String("data-dir", env("CODYNC_WEB_DATA", defaultDataDir()), "where the access key and certificates are kept (CODYNC_WEB_DATA)"),
		tlsCert:         fs.String("tls-cert", env("CODYNC_WEB_TLS_CERT", ""), "serve https with this certificate (PEM) (CODYNC_WEB_TLS_CERT)"),
		tlsKey:          fs.String("tls-key", env("CODYNC_WEB_TLS_KEY", ""), "the certificate's private key (PEM) (CODYNC_WEB_TLS_KEY)"),
		tlsSelfSigned:   fs.Bool("tls-self-signed", envBool("CODYNC_WEB_TLS_SELF_SIGNED"), "serve https with a self-signed certificate kept in the data dir (CODYNC_WEB_TLS_SELF_SIGNED)"),
		tlsHosts:        fs.String("tls-hosts", env("CODYNC_WEB_TLS_HOSTS", ""), "comma-separated names/IPs the self-signed certificate covers (default: localhost, this machine's name and addresses) (CODYNC_WEB_TLS_HOSTS)"),
		trustProxy:      fs.Bool("trust-proxy", envBool("CODYNC_WEB_TRUST_PROXY"), "behind a reverse proxy: trust X-Forwarded-For/-Proto (CODYNC_WEB_TRUST_PROXY)"),
		noAuth:          fs.Bool("no-auth", envBool("CODYNC_WEB_NO_AUTH"), "no sign-in (only for a listener nobody else can reach) (CODYNC_WEB_NO_AUTH)"),
		allowLocalCloud: fs.Bool("allow-local-cloud", envBool("CODYNC_WEB_ALLOW_LOCAL_CLOUD"), "allow a development cloud on http://127.0.0.1 (CODYNC_WEB_ALLOW_LOCAL_CLOUD)"),
		cloudURL:        fs.String("cloud-url", env("CODYNC_WEB_CLOUD_URL", "https://api.codync.dev"), "the Codync cloud for account sign-in; empty turns accounts off (pairing links still work) (CODYNC_WEB_CLOUD_URL)"),
		clerkKey:        fs.String("clerk-key", env("CODYNC_WEB_CLERK_KEY", "pk_live_Y2xlcmsuY29keW5jLmRldiQ"), "that cloud's account provider (Clerk) publishable key (CODYNC_WEB_CLERK_KEY)"),
		logLevel:        fs.String("log-level", env("CODYNC_WEB_LOG_LEVEL", "info"), "debug, info, warn or error (CODYNC_WEB_LOG_LEVEL)"),
	}
}

func serve(args []string) error {
	o := serveFlags()
	o.fs.Usage = func() {
		fmt.Fprint(os.Stderr, usage)
		o.fs.PrintDefaults()
	}
	if err := o.fs.Parse(args); err != nil {
		return err
	}
	var level slog.Level
	if err := level.UnmarshalText([]byte(*o.logLevel)); err != nil {
		return fmt.Errorf("--log-level: %w", err)
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level}))
	if !ui.Built() {
		return server.ErrNoUI
	}

	useTLS := *o.tlsCert != "" || *o.tlsKey != "" || *o.tlsSelfSigned
	host, _, err := net.SplitHostPort(*o.listen)
	if err != nil {
		return fmt.Errorf("--listen %q: %w", *o.listen, err)
	}

	var auth *server.Auth
	cfg := server.Config{
		TrustProxy: *o.trustProxy,
		TLS:        useTLS,
		Targets:    server.TargetPolicy{AllowPlainLoopbackCloud: *o.allowLocalCloud},
		Version:    version,
		CloudURL:   strings.TrimRight(*o.cloudURL, "/"),
	}
	if cfg.CloudURL != "" {
		if _, err := cfg.Targets.CloudAPITarget(cfg.CloudURL + "/v1/"); err != nil {
			return fmt.Errorf("--cloud-url %q: must be https", *o.cloudURL)
		}
		cfg.ClerkPublishableKey = *o.clerkKey
	}
	srv := server.New(cfg, nil, ui.FS(), log)
	if *o.noAuth {
		if !isLoopback(host) {
			log.Warn("sign-in is off on a listener others can reach: anyone who reaches it can use this server's bridges")
		}
	} else {
		cred, err := credential(*o.dataDir, log)
		if err != nil {
			return err
		}
		if auth, err = server.NewAuth(cred, srv.Secure); err != nil {
			return err
		}
		srv = server.New(cfg, auth, ui.FS(), log)
	}

	httpServer := &http.Server{
		Addr:              *o.listen,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		ErrorLog:          slog.NewLogLogger(log.Handler(), slog.LevelDebug),
	}
	scheme := "http"
	if useTLS {
		hosts := splitList(*o.tlsHosts)
		if len(hosts) == 0 {
			hosts = defaultCertHosts(host)
		}
		tlsConfig, err := server.LoadTLS(*o.tlsCert, *o.tlsKey, filepath.Join(*o.dataDir, "tls"), hosts)
		if err != nil {
			return err
		}
		httpServer.TLSConfig = tlsConfig
		scheme = "https"
	}

	ln, err := net.Listen("tcp", *o.listen)
	if err != nil {
		return err
	}
	if useTLS {
		ln = tls.NewListener(ln, httpServer.TLSConfig)
	}
	log.Info("codync-web listening", "version", version, "url", fmt.Sprintf("%s://%s", scheme, displayAddr(ln.Addr())), "signIn", auth != nil)
	if !useTLS && !isLoopback(host) && !*o.trustProxy {
		log.Warn("serving plain http on a public address: browsers only allow the app's cryptography on https or localhost; use --tls-self-signed, --tls-cert/--tls-key or an https reverse proxy with --trust-proxy")
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	errs := make(chan error, 1)
	go func() { errs <- httpServer.Serve(ln) }()
	select {
	case err := <-errs:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
		log.Info("shutting down")
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdown)
	}
	return nil
}

// credential is the sign-in secret: CODYNC_WEB_PASSWORD when set, else the access key kept in the
// data dir (made, and printed, on first start).
func credential(dataDir string, log *slog.Logger) (server.Credential, error) {
	stored, err := server.LoadCredential(dataDir)
	if err != nil {
		return server.Credential{}, err
	}
	if password := os.Getenv("CODYNC_WEB_PASSWORD"); password != "" {
		if len(password) < 8 {
			return server.Credential{}, errors.New("CODYNC_WEB_PASSWORD must be at least 8 characters")
		}
		if stored != nil && stored.AccessKey == "" && stored.Matches(password) {
			return *stored, nil
		}
		// A new password: a new session key too, which signs everyone out.
		c, err := server.NewCredential(password)
		if err != nil {
			return server.Credential{}, err
		}
		return c, server.SaveCredential(dataDir, c)
	}
	if stored != nil && stored.AccessKey != "" {
		return *stored, nil
	}
	c, err := newAccessKey(dataDir)
	if err != nil {
		return server.Credential{}, err
	}
	log.Info("made an access key: sign in with it in the browser (show it again with `codync-web access-key`)", "accessKey", c.AccessKey)
	return c, nil
}

func newAccessKey(dataDir string) (server.Credential, error) {
	key := server.GenerateAccessKey()
	c, err := server.NewCredential(key)
	if err != nil {
		return server.Credential{}, err
	}
	c.AccessKey = key
	return c, server.SaveCredential(dataDir, c)
}

func accessKey(args []string) error {
	fs := flag.NewFlagSet("access-key", flag.ContinueOnError)
	rotate := fs.Bool("rotate", false, "make a new access key; every browser signs in again")
	dataDir := fs.String("data-dir", env("CODYNC_WEB_DATA", defaultDataDir()), "data directory (CODYNC_WEB_DATA)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	stored, err := server.LoadCredential(*dataDir)
	if err != nil && !*rotate {
		return err
	}
	if !*rotate && stored != nil {
		if stored.AccessKey == "" {
			return errors.New("this server signs in with CODYNC_WEB_PASSWORD, not an access key")
		}
		fmt.Println(stored.AccessKey)
		return nil
	}
	c, err := newAccessKey(*dataDir)
	if err != nil {
		return err
	}
	fmt.Println(c.AccessKey)
	if stored != nil {
		fmt.Fprintln(os.Stderr, "New access key made. Restart codync-web to sign everyone out.")
	}
	return nil
}

func isLoopback(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func splitList(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// defaultCertHosts: localhost, this machine's name and every address it has (a VPS's public IP).
func defaultCertHosts(listenHost string) []string {
	hosts := []string{"localhost", "127.0.0.1", "::1"}
	if name, err := os.Hostname(); err == nil && name != "" {
		hosts = append(hosts, name)
	}
	if listenHost != "" && listenHost != "0.0.0.0" && listenHost != "::" {
		hosts = append(hosts, listenHost)
	}
	if addrs, err := net.InterfaceAddrs(); err == nil {
		for _, a := range addrs {
			if ipnet, ok := a.(*net.IPNet); ok && !ipnet.IP.IsLoopback() && !ipnet.IP.IsLinkLocalUnicast() {
				hosts = append(hosts, ipnet.IP.String())
			}
		}
	}
	seen := map[string]bool{}
	out := hosts[:0]
	for _, h := range hosts {
		if !seen[h] {
			seen[h] = true
			out = append(out, h)
		}
	}
	return out
}

func displayAddr(a net.Addr) string {
	host, port, err := net.SplitHostPort(a.String())
	if err != nil {
		return a.String()
	}
	if host == "0.0.0.0" || host == "::" {
		host = "localhost"
	}
	return net.JoinHostPort(host, port)
}
