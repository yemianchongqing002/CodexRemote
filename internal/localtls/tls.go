// Package localtls owns a persistent local identity. No CA, DNS or VPN configuration is required.
package localtls

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"

	"codexremote/internal/platform"
)

func key(path string, create bool) (*ecdsa.PrivateKey, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	// Serialize creation across service/guardian instances; never replace a lost or corrupt identity silently.
	lock, err := os.OpenFile(path+".lock", os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	defer lock.Close()
	if err = platform.Lock(lock); err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) && create {
		k, e := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if e != nil {
			return nil, e
		}
		der, e := x509.MarshalECPrivateKey(k)
		if e != nil {
			return nil, e
		}
		f, e := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if e != nil {
			return nil, e
		}
		_, e = f.Write(pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der}))
		if e == nil {
			e = f.Sync()
		}
		ce := f.Close()
		if e != nil {
			return nil, e
		}
		if ce != nil {
			return nil, ce
		}
		return k, nil
	}
	if err != nil {
		return nil, err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || !platform.PrivateMode(info) {
		return nil, errors.New("TLS 私钥必须是私有普通文件")
	}
	block, _ := pem.Decode(data)
	if block == nil {
		return nil, errors.New("TLS 私钥损坏；请恢复备份，不会自动替换身份")
	}
	return x509.ParseECPrivateKey(block.Bytes)
}

func Fingerprint(k *ecdsa.PrivateKey) string {
	der, _ := x509.MarshalPKIXPublicKey(&k.PublicKey)
	h := sha256.Sum256(der)
	return hex.EncodeToString(h[:])
}

func Server(path string) (*tls.Config, string, error) {
	k, err := key(path, true)
	if err != nil {
		return nil, "", err
	}
	var mu sync.Mutex
	var cert *tls.Certificate
	issue := func() (*tls.Certificate, error) {
		mu.Lock()
		defer mu.Unlock()
		if cert != nil && time.Until(cert.Leaf.NotAfter) > 7*24*time.Hour {
			return cert, nil
		}
		serial, e := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
		if e != nil {
			return nil, e
		}
		tmpl := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "Codex Remote local identity"}, NotBefore: time.Now().Add(-5 * time.Minute), NotAfter: time.Now().Add(90 * 24 * time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, BasicConstraintsValid: true, DNSNames: []string{"localhost"}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")}}
		der, e := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &k.PublicKey, k)
		if e != nil {
			return nil, e
		}
		leaf, e := x509.ParseCertificate(der)
		if e != nil {
			return nil, e
		}
		cert = &tls.Certificate{Certificate: [][]byte{der}, PrivateKey: k, Leaf: leaf}
		return cert, nil
	}
	if _, err = issue(); err != nil {
		return nil, "", err
	}
	return &tls.Config{MinVersion: tls.VersionTLS12, GetCertificate: func(*tls.ClientHelloInfo) (*tls.Certificate, error) { return issue() }}, Fingerprint(k), nil
}

// Guardian authenticates against the local key, not TOFU or a remote supplied fingerprint.
func Client(path string) (*tls.Config, error) {
	k, err := key(path, false)
	if err != nil {
		return nil, err
	}
	expected, _ := x509.MarshalPKIXPublicKey(&k.PublicKey)
	return &tls.Config{MinVersion: tls.VersionTLS12, InsecureSkipVerify: true, VerifyConnection: func(s tls.ConnectionState) error {
		if len(s.PeerCertificates) == 0 {
			return errors.New("missing TLS certificate")
		}
		c := s.PeerCertificates[0]
		if !bytes.Equal(expected, c.RawSubjectPublicKeyInfo) {
			return errors.New("TLS identity changed")
		}
		if time.Now().Before(c.NotBefore) || time.Now().After(c.NotAfter) {
			return errors.New("TLS certificate expired or not yet valid")
		}
		return nil
	}}, nil
}
