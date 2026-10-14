//go:build !windows

package supervisor

import (
	"context"
	"crypto/sha256"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"syscall"
)

func endpoint(path, role string) string {
	sum := sha256.Sum256([]byte(path))
	return filepath.Join("/tmp", fmt.Sprintf("cr-guard-%d-%x", os.Getuid(), sum[:12]), role+".sock")
}
func listenIPC(path, role string) (net.Listener, error) {
	address := endpoint(path, role)
	dir := filepath.Dir(address)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return nil, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.IsDir() || info.Mode().Perm() != 0700 || int(stat.Uid) != os.Getuid() {
		return nil, os.ErrPermission
	}
	// Caller holds the role lock; an old socket can no longer belong to a live role.
	if err = os.Remove(address); err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	return net.Listen("unix", address)
}
func dialIPC(ctx context.Context, path, role string) (net.Conn, error) {
	return (&net.Dialer{}).DialContext(ctx, "unix", endpoint(path, role))
}
func replaceFile(from, to string) error { return os.Rename(from, to) }
func childAttrs() *syscall.SysProcAttr  { return &syscall.SysProcAttr{Setpgid: true} }

type processRef struct {
	record  record
	process *os.Process
}

func openProcess(r record) (*processRef, error) {
	birth, err := processBirth(r.PID)
	if err != nil || birth != r.Birth {
		return nil, os.ErrProcessDone
	}
	p, err := os.FindProcess(r.PID)
	return &processRef{r, p}, err
}
func (p *processRef) close() {
	if p.process != nil {
		p.process.Release()
	}
}
func (p *processRef) kill() error {
	birth, err := processBirth(p.record.PID)
	if err != nil || birth != p.record.Birth {
		return os.ErrProcessDone
	}
	return p.process.Kill()
}
