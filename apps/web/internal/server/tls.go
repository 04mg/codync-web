package server

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"slices"
	"time"
)

// SelfSignedCert loads the certificate kept in `dir`, or makes one for `hosts` when there is none,
// it expires within a month, or it doesn't cover `hosts`. Browsers warn once about it; the page is
// then a secure context, which the app's cryptography (WebCrypto) requires.
func SelfSignedCert(dir string, hosts []string) (tls.Certificate, error) {
	certPath, keyPath := filepath.Join(dir, "self-signed.crt"), filepath.Join(dir, "self-signed.key")
	if cert, err := tls.LoadX509KeyPair(certPath, keyPath); err == nil && covers(cert, hosts) {
		return cert, nil
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}
	serial, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 120))
	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: "Codync web (self-signed)"},
		NotBefore:    time.Now().Add(-time.Hour),
		// Browsers refuse server certificates valid for more than 398 days.
		NotAfter:    time.Now().Add(397 * 24 * time.Hour),
		KeyUsage:    x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	for _, h := range hosts {
		if ip := net.ParseIP(h); ip != nil {
			tmpl.IPAddresses = append(tmpl.IPAddresses, ip)
		} else {
			tmpl.DNSNames = append(tmpl.DNSNames, h)
		}
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return tls.Certificate{}, err
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return tls.Certificate{}, err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return tls.Certificate{}, err
	}
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}), 0o600); err != nil {
		return tls.Certificate{}, err
	}
	if err := os.WriteFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o644); err != nil {
		return tls.Certificate{}, err
	}
	return tls.LoadX509KeyPair(certPath, keyPath)
}

func covers(cert tls.Certificate, hosts []string) bool {
	if len(cert.Certificate) == 0 {
		return false
	}
	leaf, err := x509.ParseCertificate(cert.Certificate[0])
	if err != nil || time.Until(leaf.NotAfter) < 30*24*time.Hour {
		return false
	}
	for _, h := range hosts {
		if ip := net.ParseIP(h); ip != nil {
			if !slices.ContainsFunc(leaf.IPAddresses, ip.Equal) {
				return false
			}
		} else if !slices.Contains(leaf.DNSNames, h) {
			return false
		}
	}
	return true
}

// LoadTLS returns a TLS config from certificate files or a self-signed certificate.
func LoadTLS(certFile, keyFile string, selfSignedDir string, hosts []string) (*tls.Config, error) {
	var cert tls.Certificate
	var err error
	switch {
	case certFile != "" && keyFile != "":
		cert, err = tls.LoadX509KeyPair(certFile, keyFile)
	case certFile != "" || keyFile != "":
		return nil, errors.New("--tls-cert and --tls-key go together")
	default:
		cert, err = SelfSignedCert(selfSignedDir, hosts)
	}
	if err != nil {
		return nil, fmt.Errorf("TLS certificate: %w", err)
	}
	return &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}, nil
}
