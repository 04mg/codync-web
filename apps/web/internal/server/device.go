package server

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sync"
)

// DeviceStore is this server's Codync device, shared by every browser that uses it, the way the
// account sign-in is (AccountSession): its Ed25519 device keys (§3.2: `local` for computers paired
// with a link, one per account context) and the computers they paired with. The private keys never
// leave the server: browsers ask it to sign (`POST /device/keys/{context}/sign`). Computers are
// saved as the browser hands them over (public keys and addresses only).
type DeviceStore struct {
	path string

	mu   sync.Mutex
	data deviceData
}

type deviceData struct {
	// Ed25519 seeds by context.
	Keys map[string][]byte `json:"keys"`
	// Saved computers by id, as the app stores them.
	Computers map[string]json.RawMessage `json:"computers"`
}

const (
	maxSignedMessage = 64 << 10
	maxComputer      = 64 << 10
	maxComputers     = 256
)

var (
	deviceContext = regexp.MustCompile(`^(local|account:[A-Za-z0-9_-]{16})$`)
	computerID    = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
)

// NewDeviceStore loads the device kept in `dataDir`.
func NewDeviceStore(dataDir string) (*DeviceStore, error) {
	d := &DeviceStore{path: filepath.Join(dataDir, "device.json")}
	raw, err := os.ReadFile(d.path)
	switch {
	case err == nil:
		if err := json.Unmarshal(raw, &d.data); err != nil {
			return nil, errors.New("device.json is damaged")
		}
	case !errors.Is(err, os.ErrNotExist):
		return nil, err
	}
	if d.data.Keys == nil {
		d.data.Keys = map[string][]byte{}
	}
	if d.data.Computers == nil {
		d.data.Computers = map[string]json.RawMessage{}
	}
	return d, nil
}

// save writes the store; the caller holds mu.
func (d *DeviceStore) save() error {
	raw, err := json.Marshal(d.data)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(d.path), 0o700); err != nil {
		return err
	}
	tmp := d.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, d.path)
}

// key is the context's private key, made on first use.
func (d *DeviceStore) key(context string) (ed25519.PrivateKey, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if seed, ok := d.data.Keys[context]; ok && len(seed) == ed25519.SeedSize {
		return ed25519.NewKeyFromSeed(seed), nil
	}
	seed := make([]byte, ed25519.SeedSize)
	if _, err := rand.Read(seed); err != nil {
		return nil, err
	}
	d.data.Keys[context] = seed
	if err := d.save(); err != nil {
		delete(d.data.Keys, context)
		return nil, err
	}
	return ed25519.NewKeyFromSeed(seed), nil
}

func (s *Server) deviceRoutes(mux *http.ServeMux) {
	guard := func(h http.HandlerFunc) http.Handler { return s.sameOrigin(s.signedIn(h)) }
	mux.Handle("GET /device/keys/{context}", guard(s.handleDeviceKey))
	mux.Handle("POST /device/keys/{context}/sign", guard(s.handleDeviceSign))
	mux.Handle("GET /device/computers", guard(s.handleComputers))
	mux.Handle("PUT /device/computers/{id}", guard(s.handlePutComputer))
	mux.Handle("DELETE /device/computers/{id}", guard(s.handleDeleteComputer))
	mux.Handle("POST /device/reset", guard(s.handleDeviceReset))
}

func (s *Server) contextKey(w http.ResponseWriter, r *http.Request) ed25519.PrivateKey {
	context := r.PathValue("context")
	if !deviceContext.MatchString(context) {
		http.Error(w, "bad context", http.StatusBadRequest)
		return nil
	}
	key, err := s.cfg.Device.key(context)
	if err != nil {
		s.log.Error("device key", "error", err)
		http.Error(w, "device key unavailable", http.StatusInternalServerError)
		return nil
	}
	return key
}

func (s *Server) handleDeviceKey(w http.ResponseWriter, r *http.Request) {
	if key := s.contextKey(w, r); key != nil {
		writeJSON(w, http.StatusOK, map[string]string{"publicKey": base64.RawURLEncoding.EncodeToString(key.Public().(ed25519.PublicKey))})
	}
}

func (s *Server) handleDeviceSign(w http.ResponseWriter, r *http.Request) {
	key := s.contextKey(w, r)
	if key == nil {
		return
	}
	message, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxSignedMessage))
	if err != nil {
		http.Error(w, "message too large", http.StatusRequestEntityTooLarge)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(ed25519.Sign(key, message))
}

func (s *Server) handleComputers(w http.ResponseWriter, _ *http.Request) {
	d := s.cfg.Device
	d.mu.Lock()
	list := make([]json.RawMessage, 0, len(d.data.Computers))
	for _, c := range d.data.Computers {
		list = append(list, c)
	}
	d.mu.Unlock()
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) handlePutComputer(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxComputer))
	var obj map[string]json.RawMessage
	if !computerID.MatchString(id) || err != nil || json.Unmarshal(raw, &obj) != nil {
		http.Error(w, "bad computer", http.StatusBadRequest)
		return
	}
	d := s.cfg.Device
	d.mu.Lock()
	defer d.mu.Unlock()
	previous, existed := d.data.Computers[id]
	if !existed && len(d.data.Computers) >= maxComputers {
		http.Error(w, "too many computers", http.StatusConflict)
		return
	}
	d.data.Computers[id] = raw
	if err := d.save(); err != nil {
		if existed {
			d.data.Computers[id] = previous
		} else {
			delete(d.data.Computers, id)
		}
		s.log.Error("saving computers", "error", err)
		http.Error(w, "couldn't save", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleDeleteComputer(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	d := s.cfg.Device
	d.mu.Lock()
	defer d.mu.Unlock()
	if previous, ok := d.data.Computers[id]; ok {
		delete(d.data.Computers, id)
		if err := d.save(); err != nil {
			d.data.Computers[id] = previous
			s.log.Error("saving computers", "error", err)
			http.Error(w, "couldn't save", http.StatusInternalServerError)
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleDeviceReset forgets the device ("Reset all data"): its computers have to pair again.
func (s *Server) handleDeviceReset(w http.ResponseWriter, _ *http.Request) {
	d := s.cfg.Device
	d.mu.Lock()
	defer d.mu.Unlock()
	d.data = deviceData{Keys: map[string][]byte{}, Computers: map[string]json.RawMessage{}}
	if err := d.save(); err != nil {
		s.log.Error("resetting the device", "error", err)
		http.Error(w, "couldn't reset", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
