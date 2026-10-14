package platform

import (
	"context"
	"os"
	"os/exec"

	"golang.org/x/sys/windows"
)

// The byte-range lock is released when the file handle is closed.
func Lock(f *os.File) error {
	return windows.LockFileEx(windows.Handle(f.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &windows.Overlapped{})
}

// Windows uses ACLs, not POSIX mode bits. State must reside in the user's
// private profile directory (or a directory with an equivalent restricted ACL).
func PrivateMode(info os.FileInfo) bool { return true }

// Windows does not support flushing directory handles through os.File.Sync.
// Queue contents are flushed separately before the journal is committed.
func SyncDir(path string) error { return nil }

// Do not guess a desktop-version-specific pipe name.
func IPCPath(home string) string { return "" }
func CodexBinary() string        { return "codex.exe" }
func OpenThread(ctx context.Context, id string) error {
	return exec.CommandContext(ctx, "rundll32.exe", "url.dll,FileProtocolHandler", "codex://threads/"+id).Run()
}
