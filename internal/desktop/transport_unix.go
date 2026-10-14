//go:build !windows

package desktop

import (
	"context"
	"errors"
	"net"
	"os"
	"time"
)

func dialDesktop(ctx context.Context, address string) (net.Conn, error) {
	info, err := os.Lstat(address)
	if err != nil || info.Mode()&os.ModeSocket == 0 {
		return nil, errors.New("桌面接口不可用，请打开目标电脑上的 Codex 桌面版")
	}
	d := net.Dialer{Timeout: 3 * time.Second}
	conn, err := d.DialContext(ctx, "unix", address)
	if err != nil {
		return nil, errors.New("无法连接 Codex 桌面版")
	}
	return conn, nil
}
