package server

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
)

// Admin-maintained disclosure must cover all providers used by this server,
// including project-specific overrides. Never infer a provider from a model name.
type privacyRecipient struct {
	Name       string `json:"name"`
	PrivacyURL string `json:"privacyURL"`
}
type privacyInfo struct {
	SchemaVersion int                `json:"schemaVersion"`
	Purpose       string             `json:"purpose"`
	Recipients    []privacyRecipient `json:"recipients"`
	Configured    bool               `json:"configured"`
	Revision      string             `json:"revision"`
}

func (s *Server) readPrivacy() privacyInfo {
	empty := privacyInfo{SchemaVersion: 1, Recipients: []privacyRecipient{}}
	file, err := os.Open(s.cfg.PrivacyFile)
	if err != nil {
		return empty
	}
	defer file.Close()
	var input struct {
		SchemaVersion int                `json:"schemaVersion"`
		Purpose       string             `json:"purpose"`
		Recipients    []privacyRecipient `json:"recipients"`
	}
	decoder := json.NewDecoder(io.LimitReader(file, 16385))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || input.SchemaVersion != 1 || len(input.Recipients) == 0 || len(input.Recipients) > 16 || len(strings.TrimSpace(input.Purpose)) == 0 || len(input.Purpose) > 2048 {
		return empty
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return empty
	}
	for _, r := range input.Recipients {
		u, err := url.Parse(r.PrivacyURL)
		if len(strings.TrimSpace(r.Name)) == 0 || len(r.Name) > 200 || len(r.PrivacyURL) > 2048 || err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil {
			return empty
		}
	}
	canonical, _ := json.Marshal(input)
	hash := sha256.Sum256(canonical)
	return privacyInfo{SchemaVersion: 1, Purpose: input.Purpose, Recipients: input.Recipients, Configured: true, Revision: hex.EncodeToString(hash[:])}
}
func (s *Server) privacyDisclosure(w http.ResponseWriter, r *http.Request) {
	if !only(w, r, "GET") {
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	reply(w, 200, s.readPrivacy())
}

// New clients bind writes to the disclosure they confirmed. Legacy clients do
// not send this parameter; it is a consistency guard, not authentication.
func (s *Server) checkPrivacyRevision(w http.ResponseWriter, r *http.Request) bool {
	values, present := r.URL.Query()["consentRevision"]
	if !present {
		return true
	}
	info := s.readPrivacy()
	if len(values) != 1 || !info.Configured || values[0] != info.Revision {
		http.Error(w, "数据接收方说明已变化，请重新确认后发送", http.StatusConflict)
		return false
	}
	return true
}
