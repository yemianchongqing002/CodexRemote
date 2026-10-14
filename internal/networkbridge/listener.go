// Package networkbridge accepts streams from the application's embedded tailnet.
// A per-start secret is shared only through a private local descriptor file.
package networkbridge

import (
	"bufio"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

func Tailnet(ip net.IP) bool {
	if v := ip.To4(); v != nil {
		return v[0] == 100 && v[1] >= 64 && v[1] <= 127
	}
	return ip != nil && strings.HasPrefix(ip.String(), "fd7a:115c:a1e0:")
}
func Path(port string) string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "codex-remote", "network", port+".bridge")
}

type Listener struct {
	once sync.Once
	net.Listener
	secret, path, record string
	ready                chan net.Conn
	done                 chan struct{}
	slots                chan struct{}
}
type conn struct {
	net.Conn
	reader        *bufio.Reader
	local, remote net.Addr
}

func (c *conn) Read(b []byte) (int, error) { return c.reader.Read(b) }
func (c *conn) LocalAddr() net.Addr        { return c.local }
func (c *conn) RemoteAddr() net.Addr       { return c.remote }
func New(path string) (*Listener, error) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	key := make([]byte, 32)
	if _, err = rand.Read(key); err != nil {
		listener.Close()
		return nil, err
	}
	l := &Listener{Listener: listener, secret: hex.EncodeToString(key), path: path, ready: make(chan net.Conn), done: make(chan struct{}), slots: make(chan struct{}, 64)}
	l.record = fmt.Sprintf("%d %s\n", listener.Addr().(*net.TCPAddr).Port, l.secret)
	if err = os.MkdirAll(filepath.Dir(path), 0700); err == nil {
		var f *os.File
		f, err = os.CreateTemp(filepath.Dir(path), ".bridge-")
		if err == nil {
			_, err = f.WriteString(l.record)
			f.Close()
			if err == nil {
				err = os.Rename(f.Name(), path)
			}
			os.Remove(f.Name())
		}
	}
	if err != nil {
		listener.Close()
		return nil, err
	}
	go l.run()
	return l, nil
}
func (l *Listener) run() {
	for {
		c, err := l.Listener.Accept()
		if err != nil {
			return
		}
		select {
		case l.slots <- struct{}{}:
			go l.handshake(c)
		default:
			c.Close()
		}
	}
}
func (l *Listener) handshake(c net.Conn) {
	defer func() { <-l.slots }()
	ok := false
	defer func() {
		if !ok {
			c.Close()
		}
	}()
	c.SetDeadline(time.Now().Add(3 * time.Second))
	r := bufio.NewReaderSize(c, 512)
	line, err := r.ReadSlice('\n')
	if err != nil {
		return
	}
	parts := strings.Fields(string(line))
	if len(parts) != 4 || parts[0] != "CRNET1" || subtle.ConstantTimeCompare([]byte(parts[1]), []byte(l.secret)) != 1 {
		return
	}
	locals := []net.IP{}
	for _, value := range strings.Split(parts[2], ",") {
		ip := net.ParseIP(value)
		if !Tailnet(ip) {
			return
		}
		locals = append(locals, ip)
	}
	remote := net.ParseIP(parts[3])
	if len(locals) == 0 || !Tailnet(remote) {
		return
	}
	if _, err = c.Write([]byte("OK\n")); err != nil {
		return
	}
	c.SetDeadline(time.Time{})
	wrapped := &conn{Conn: c, reader: r, local: &localAddr{IPs: locals}, remote: &net.TCPAddr{IP: remote}}
	// Shutdown cannot close ready while a sender is active: accept loop owns done,
	// handshakes deliver through an independent public Accept path.
	select {
	case <-l.done:
		return
	case l.ready <- wrapped:
		ok = true
	}
}
func (l *Listener) Accept() (net.Conn, error) {
	select {
	case <-l.done:
		return nil, net.ErrClosed
	case c, ok := <-l.ready:
		if !ok {
			return nil, net.ErrClosed
		}
		return c, nil
	}
}
func (l *Listener) Close() (err error) {
	l.once.Do(func() {
		close(l.done)
		err = l.Listener.Close()
		if b, e := os.ReadFile(l.path); e == nil && string(b) == l.record {
			os.Remove(l.path)
		}
	})
	return
}

type localAddr struct{ IPs []net.IP }

func (a *localAddr) Network() string { return "tcp" }
func (a *localAddr) String() string  { return net.JoinHostPort(a.IPs[0].String(), "0") }
func (a *localAddr) AllowsIP(ip net.IP) bool {
	for _, v := range a.IPs {
		if v.Equal(ip) {
			return true
		}
	}
	return false
}
