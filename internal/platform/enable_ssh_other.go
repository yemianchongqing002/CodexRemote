//go:build !windows

package platform

import (
	"context"
	"errors"
)

func EnableSSH(context.Context) error {
	return errors.New("--enable-ssh 仅支持 Windows，请在目标 Windows 电脑上运行")
}
