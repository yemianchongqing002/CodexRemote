package desktop

import (
	"context"
	"errors"
	"net"
	"strings"
	"time"

	winio "github.com/Microsoft/go-winio"
)

func dialDesktop(ctx context.Context, address string) (net.Conn, error) {
	if !strings.HasPrefix(strings.ToLower(address), `\\.\pipe\`) || len(address) <= len(`\\.\pipe\`) {
		return nil, errors.New(`Windows 桌面发送需要 --ipc-socket 指定实际本机命名管道（\\.\pipe\名称）；请先确认桌面版本支持 follower 协议`)
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	conn, err := winio.DialPipeContext(ctx, address)
	if err != nil {
		return nil, errors.New("无法连接 Windows Codex 桌面命名管道，请检查地址和桌面运行状态")
	}
	return conn, nil
}
