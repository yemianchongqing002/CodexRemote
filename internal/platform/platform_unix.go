//go:build !windows

package platform

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"syscall"
)

func Lock(f *os.File) error             { return syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) }
func PrivateMode(info os.FileInfo) bool { return info.Mode().Perm()&0077 == 0 }
func IPCPath(home string) string        { return filepath.Join(home, "ipc", "ipc.sock") }
func SyncDir(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}
func CodexBinary() string {
	if runtime.GOOS == "darwin" {
		apps := []string{"/Applications/ChatGPT.app", "/Applications/Codex.app"}
		home, _ := os.UserHomeDir()
		if home != "" {
			apps = append(apps, filepath.Join(home, "Applications/ChatGPT.app"), filepath.Join(home, "Applications/Codex.app"))
		}
		for _, app := range apps {
			for _, relative := range []string{"codex-cli/bin/codex", "codex"} {
				candidate := filepath.Join(app, "Contents/Resources", relative)
				if info, err := os.Stat(candidate); err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0111 != 0 {
					return candidate
				}
			}
		}
		if home != "" {
			candidate := filepath.Join(home, ".local/bin/codex")
			if info, err := os.Stat(candidate); err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0111 != 0 {
				return candidate
			}
		}
	}
	return "codex"
}
func OpenThread(ctx context.Context, id string) error {
	command := "xdg-open"
	if runtime.GOOS == "darwin" {
		command = "/usr/bin/open"
	}
	return exec.CommandContext(ctx, command, "codex://threads/"+id).Run()
}
