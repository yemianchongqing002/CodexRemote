package networkbridge

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestAuthenticatedStream(t *testing.T) {
	path := filepath.Join(t.TempDir(), "8787.bridge")
	l, err := New(path)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	st, _ := os.Stat(path)
	if st.Mode().Perm() != 0600 {
		t.Fatal(st.Mode())
	}
	b, _ := os.ReadFile(path)
	parts := strings.Fields(string(b))
	c, err := net.Dial("tcp", "127.0.0.1:"+parts[0])
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(time.Second))
	fmt.Fprintf(c, "CRNET1 %s 100.64.10.12,fd7a:115c:a1e0::1 100.64.10.14\nGET /api/status HTTP/1.1\r\nHost: 100.64.10.12:8787\r\n\r\n", parts[1])
	ack := make([]byte, 3)
	if _, err = io.ReadFull(c, ack); err != nil || string(ack) != "OK\n" {
		t.Fatalf("ack %q %v", ack, err)
	}
	accepted, err := l.Accept()
	if err != nil {
		t.Fatal(err)
	}
	defer accepted.Close()
	if !accepted.LocalAddr().(*localAddr).AllowsIP(net.ParseIP("fd7a:115c:a1e0::1")) {
		t.Fatal("missing IPv6")
	}
	if accepted.RemoteAddr().String() != "100.64.10.14:0" {
		t.Fatal(accepted.RemoteAddr())
	}
	line, err := bufio.NewReader(accepted).ReadString('\n')
	if err != nil || line != "GET /api/status HTTP/1.1\r\n" {
		t.Fatalf("buffered HTTP %q %v", line, err)
	}
	l.Close()
	if _, err = os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("descriptor not removed")
	}
}
func TestRejectForgedBridge(t *testing.T) {
	l, err := New(filepath.Join(t.TempDir(), "test.bridge"))
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	for _, line := range []string{"CRNET1 wrong 100.64.0.1 100.64.0.2\n", "CRNET1 " + l.secret + " 127.0.0.1 100.64.0.2\n"} {
		c, e := net.Dial("tcp", l.Addr().String())
		if e != nil {
			t.Fatal(e)
		}
		c.SetDeadline(time.Now().Add(time.Second))
		io.WriteString(c, line)
		b := make([]byte, 3)
		n, e := c.Read(b)
		c.Close()
		if n != 0 || e == nil {
			t.Fatal("forged stream accepted")
		}
	}
}
