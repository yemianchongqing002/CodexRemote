package desktop

import (
	"os/exec"
	"syscall"
)

func hideCatalogWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}
