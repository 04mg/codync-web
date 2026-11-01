package server

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

// The cloud API proxy: the Codync cloud's `/v1` API and the account provider's Frontend API send
// no CORS headers for a self-hosted origin, so the browser asks this server to make the request.
// The browser signs (`Codync-Sig`, with its own device key) and authenticates (`Authorization`)
// the request itself; the server forwards it as is and returns the answer. Only `/v1/` paths of
// https origins are reachable (TargetPolicy.CloudAPITarget). Requests to the account provider carry
// the server's account session instead of anything the browser sends (AccountSession).

const (
	proxyMaxRequest  = 8 << 20
	proxyMaxResponse = 16 << 20
	proxyTimeout     = 30 * time.Second
)

// Request headers the browser may set upstream; everything else is dropped.
var proxyRequestHeaders = map[string]bool{
	"accept":        true,
	"authorization": true,
	"codync-sig":    true,
	"content-type":  true,
	// Clerk's native-client headers (apps/desktop/src/main/account.ts).
	"x-device-type": true,
	"x-app-version": true,
	"x-bundle-id":   true,
}

// Response headers handed back to the browser.
var proxyResponseHeaders = []string{"Content-Type", "Retry-After"}

type proxyRequest struct {
	Method  string            `json:"method"`
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers"`
	// Base64 (standard, padded); empty for no body.
	Body string `json:"body"`
}

type proxyResponse struct {
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
}

func (s *Server) handleBridgeHTTP(w http.ResponseWriter, r *http.Request) {
	var req proxyRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, proxyMaxRequest*2)).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	target, err := s.targets.CloudAPITarget(req.URL)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	switch req.Method {
	case http.MethodGet, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
	default:
		http.Error(w, "method not allowed", http.StatusBadRequest)
		return
	}
	body, err := base64.StdEncoding.DecodeString(req.Body)
	if err != nil || len(body) > proxyMaxRequest {
		http.Error(w, "bad body", http.StatusBadRequest)
		return
	}
	var reader io.Reader
	if len(body) > 0 {
		reader = bytes.NewReader(body)
	}
	up, err := http.NewRequestWithContext(r.Context(), req.Method, target.String(), reader)
	if err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	account := s.cfg.Account
	owned := account.Owns(target)
	for k, v := range req.Headers {
		if proxyRequestHeaders[strings.ToLower(k)] && validHeaderValue(v) && !(owned && strings.EqualFold(k, "authorization")) {
			up.Header.Set(k, v)
		}
	}
	if owned {
		if token := account.Token(); token != "" {
			up.Header.Set("Authorization", token)
		}
	}
	res, err := s.upstream.Do(up)
	if err != nil {
		writeJSON(w, http.StatusOK, proxyResponse{Status: 0})
		return
	}
	defer res.Body.Close()
	if v, ok := res.Header["Authorization"]; owned && ok && len(v) > 0 {
		if err := account.Rotate(v[0]); err != nil {
			s.log.Error("saving the account session", "error", err)
		}
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, proxyMaxResponse+1))
	if err != nil || len(data) > proxyMaxResponse {
		writeJSON(w, http.StatusOK, proxyResponse{Status: 0})
		return
	}
	headers := map[string]string{}
	for _, h := range proxyResponseHeaders {
		if v, ok := res.Header[h]; ok && len(v) > 0 {
			headers[strings.ToLower(h)] = v[0]
		}
	}
	writeJSON(w, http.StatusOK, proxyResponse{Status: res.StatusCode, Headers: headers, Body: base64.StdEncoding.EncodeToString(data)})
}

func validHeaderValue(v string) bool {
	if len(v) > 8192 {
		return false
	}
	for _, c := range v {
		if c < 0x20 || c == 0x7f {
			return false
		}
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
