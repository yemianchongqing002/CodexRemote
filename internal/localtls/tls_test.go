package localtls

import (
	"crypto/tls"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestIdentityPersistenceRenewalAndReplacement(t *testing.T) {
	path := filepath.Join(t.TempDir(), "key.pem")
	first, pin, err := Server(path)
	if err != nil {
		t.Fatal(err)
	}
	second, pin2, err := Server(path)
	if err != nil || pin != pin2 {
		t.Fatalf("identity not persistent: %v", err)
	}
	c1, _ := first.GetCertificate(&tls.ClientHelloInfo{})
	c2, _ := second.GetCertificate(&tls.ClientHelloInfo{})
	if string(c1.Certificate[0]) == string(c2.Certificate[0]) {
		t.Fatal("expected renewed certificate")
	}
	clientConfig, err := Client(path)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) }))
	second.Certificates = []tls.Certificate{*c2}
	server.TLS = second
	server.StartTLS()
	defer server.Close()
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: clientConfig}}
	resp, err := client.Get(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	other, _, err := Server(filepath.Join(t.TempDir(), "other.pem"))
	if err != nil {
		t.Fatal(err)
	}
	changed := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("HTTP must not run on mismatched identity") }))
	oc, _ := other.GetCertificate(&tls.ClientHelloInfo{})
	other.Certificates = []tls.Certificate{*oc}
	changed.TLS = other
	changed.StartTLS()
	defer changed.Close()
	if _, err = client.Get(changed.URL); err == nil {
		t.Fatal("accepted changed key")
	}
	if err = os.WriteFile(path, []byte("corrupt"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err = Server(path); err == nil {
		t.Fatal("silently replaced corrupt identity")
	}
}
