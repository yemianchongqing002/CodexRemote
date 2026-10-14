//go:build !windows

package desktop

import (
	"net"
	"os"
	"path/filepath"
	"testing"
)

func testListener(t *testing.T) (string, net.Listener, error) {
	t.Helper()
	dir, err := os.MkdirTemp("", "cr-ipc-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	path := filepath.Join(dir, "ipc.sock")
	listener, err := net.Listen("unix", path)
	return path, listener, err
}
