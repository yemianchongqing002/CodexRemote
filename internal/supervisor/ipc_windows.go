package supervisor

import (
	"context"
	"crypto/sha256"
	"fmt"
	"net"
	"os"
	"strings"
	"syscall"

	winio "github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

func endpoint(path, role string) string {
	return fmt.Sprintf(`\\.\pipe\codex-remote-guard-%x-%s`, sha256.Sum256([]byte(strings.ToLower(path))), role)
}
func listenIPC(path, role string) (net.Listener, error) {
	u, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return nil, err
	}
	return winio.ListenPipe(endpoint(path, role), &winio.PipeConfig{SecurityDescriptor: "D:P(A;;GA;;;" + u.User.Sid.String() + ")", InputBufferSize: 4096, OutputBufferSize: 4096})
}
func dialIPC(ctx context.Context, path, role string) (net.Conn, error) {
	return winio.DialPipeContext(ctx, endpoint(path, role))
}
func replaceFile(from, to string) error {
	a, e := windows.UTF16PtrFromString(from)
	if e != nil {
		return e
	}
	b, e := windows.UTF16PtrFromString(to)
	if e != nil {
		return e
	}
	return windows.MoveFileEx(a, b, windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH)
}
func childAttrs() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{CreationFlags: windows.CREATE_NO_WINDOW}
}

type processRef struct{ handle windows.Handle }

func birthOf(h windows.Handle) (string, error) {
	var created, exited, kernel, user windows.Filetime
	err := windows.GetProcessTimes(h, &created, &exited, &kernel, &user)
	return fmt.Sprintf("%d:%d", created.HighDateTime, created.LowDateTime), err
}
func processBirth(pid int) (string, error) {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return "", err
	}
	defer windows.CloseHandle(h)
	return birthOf(h)
}
func openProcess(r record) (*processRef, error) {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.PROCESS_TERMINATE|windows.SYNCHRONIZE, false, uint32(r.PID))
	if err != nil {
		return nil, err
	}
	birth, err := birthOf(h)
	if err != nil || birth != r.Birth {
		windows.CloseHandle(h)
		return nil, os.ErrProcessDone
	}
	return &processRef{h}, nil
}
func (p *processRef) close()      { windows.CloseHandle(p.handle) }
func (p *processRef) kill() error { return windows.TerminateProcess(p.handle, 1) }
