package platform

import (
	"context"
	_ "embed"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"unicode/utf16"

	"golang.org/x/sys/windows"
)

//go:embed enable_ssh.ps1
var enableSSHScript string

// EnableSSH runs only from the explicit local CLI action. It does not elevate
// the normal service, accept caller-provided commands, or change SSH credentials.
func EnableSSH(ctx context.Context) error {
	system, err := windows.GetSystemDirectory()
	if err != nil {
		return err
	}
	powershell := filepath.Join(system, "WindowsPowerShell", "v1.0", "powershell.exe")
	script := enableSSHScript
	if !windows.GetCurrentProcessToken().IsElevated() {
		executable, err := os.Executable()
		if err != nil {
			return err
		}
		fmt.Println("请在 Windows UAC 窗口中确认开启 SSH。")
		script = "$ErrorActionPreference='Stop'; try { $p=Start-Process -FilePath '" + strings.ReplaceAll(executable, "'", "''") + "' -ArgumentList '--enable-ssh' -Verb RunAs -Wait -PassThru; exit $p.ExitCode } catch { Write-Error '无法获得管理员权限，或 UAC 已取消；SSH 设置未确认。'; exit 1 }"
	}
	units := utf16.Encode([]rune(script))
	bytes := make([]byte, len(units)*2)
	for i, u := range units {
		binary.LittleEndian.PutUint16(bytes[i*2:], u)
	}
	cmd := exec.CommandContext(ctx, powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", base64.StdEncoding.EncodeToString(bytes))
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("开启 SSH 未完成，请检查上方错误；若提示重启，请重启 Windows 后重新运行：%w", err)
	}
	fmt.Println("SSH 已开启。请返回网页，使用目标电脑的账号密码连接端口 22。")
	return nil
}
