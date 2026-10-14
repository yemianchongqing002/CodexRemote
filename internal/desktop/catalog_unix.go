//go:build !windows

package desktop

import "os/exec"

func hideCatalogWindow(cmd *exec.Cmd) {}
