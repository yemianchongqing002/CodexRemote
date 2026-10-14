package desktop

import (
	"context"
	"net"
	"testing"

	winio "github.com/Microsoft/go-winio"
)

func testListener(t *testing.T) (string, net.Listener, error) {
	t.Helper()
	path := `\\.\pipe\codex-remote-test-` + uid()
	listener, err := winio.ListenPipe(path, nil)
	return path, listener, err
}

func TestRejectRemoteOrUnspecifiedPipe(t *testing.T) {
	for _, address := range []string{"", `\\server\pipe\codex`, `C:\ipc.sock`, `\\.\pipe\`} {
		if conn, err := dialDesktop(context.Background(), address); err == nil {
			conn.Close()
			t.Fatalf("accepted invalid pipe %q", address)
		}
	}
}
