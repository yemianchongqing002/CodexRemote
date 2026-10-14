package platform

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLockExclusiveAndReleasedOnClose(t *testing.T) {
	path := filepath.Join(t.TempDir(), "outbox")
	first, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	second, err := os.OpenFile(path, os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	if err := Lock(first); err != nil {
		t.Fatal(err)
	}
	if err := Lock(second); err == nil {
		t.Fatal("second writer acquired lock")
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	if err := Lock(second); err != nil {
		t.Fatalf("lock not released: %v", err)
	}
}
