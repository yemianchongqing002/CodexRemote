package server

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestPrivacyDisclosureAndWriteRevision(t *testing.T) {
	s, _ := setup(t)
	s.cfg.NoAuth = true
	s.cfg.PrivacyFile = filepath.Join(t.TempDir(), "privacy.json")
	if s.readPrivacy().Configured {
		t.Fatal("missing file trusted")
	}
	data := `{"schemaVersion":1,"purpose":"Process the requested AI task","recipients":[{"name":"Example AI","privacyURL":"https://example.test/privacy"}]}`
	if err := os.WriteFile(s.cfg.PrivacyFile, []byte(data), 0600); err != nil {
		t.Fatal(err)
	}
	info := s.readPrivacy()
	if !info.Configured || len(info.Revision) != 64 {
		t.Fatal(info)
	}
	w := request(s, "GET", "/api/privacy", "", nil)
	if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal(w)
	}
	for _, revision := range []string{"", "old", info.Revision} {
		r := httptest.NewRequest("POST", "http://localhost/api/send?consentRevision="+revision, nil)
		w := httptest.NewRecorder()
		ok := s.checkPrivacyRevision(w, r)
		if ok != (revision == info.Revision) {
			t.Fatal("revision guard", revision, w.Code)
		}
	}
	os.WriteFile(s.cfg.PrivacyFile, []byte(`{"schemaVersion":1,"purpose":"changed","recipients":[{"name":"Example AI","privacyURL":"https://example.test/privacy"}]}`), 0600)
	if s.readPrivacy().Revision == info.Revision {
		t.Fatal("purpose change did not invalidate consent")
	}
	os.WriteFile(s.cfg.PrivacyFile, []byte(`{"schemaVersion":1,"purpose":"x","recipients":[{"name":"x","privacyURL":"https://secret@example.test"}]}`), 0600)
	if s.readPrivacy().Configured {
		t.Fatal("credential URL exposed")
	}
}
