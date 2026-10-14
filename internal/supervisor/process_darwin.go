package supervisor

import (
	"fmt"
	"golang.org/x/sys/unix"
)

func processBirth(pid int) (string, error) {
	p, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%d:%d", p.Proc.P_starttime.Sec, p.Proc.P_starttime.Usec), nil
}
