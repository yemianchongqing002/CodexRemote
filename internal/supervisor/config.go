// Package supervisor implements two mutually monitored roles without an HTTP proxy.
package supervisor

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"

	"codexremote/internal/platform"
)

// ServiceConfig is an allowlist of business settings, never a copy of argv.
type ServiceConfig struct {
	TLS bool `json:"tls"`
	// Name is a display-name snapshot; the running server reads the current OS name.
	Name         string `json:"name"`
	Listen       string `json:"listen"`
	Home         string `json:"codexHome"`
	TokenFile    string `json:"tokenFile"`
	RequireToken bool   `json:"requireToken"`
	AllowHost    string `json:"allowHost"`
	Interval     string `json:"interval"`
	ReadOnly     bool   `json:"readOnly"`
	IPCSocket    string `json:"ipcSocket"`
	OpenCreated  bool   `json:"openCreated"`
	OpenOnSend   bool   `json:"openOnSend"`
	CodexBinary  string `json:"codexBinary"`
}

type Config struct {
	Version    int           `json:"version"`
	Executable string        `json:"executable"`
	Service    ServiceConfig `json:"service"`
}

func (c Config) Validate() error {
	if c.Version != 1 || !filepath.IsAbs(c.Executable) || !filepath.IsAbs(c.Service.Home) || !filepath.IsAbs(c.Service.TokenFile) {
		return errors.New("守护配置版本或绝对路径无效")
	}
	_, port, err := net.SplitHostPort(c.Service.Listen)
	if err != nil || port == "" || port == "0" {
		return errors.New("服务监听地址无效")
	}
	if number, e := net.LookupPort("tcp", port); e != nil || number < 1 {
		return errors.New("服务端口无效")
	}
	if d, e := time.ParseDuration(c.Service.Interval); e != nil || d < time.Second {
		return errors.New("检查间隔至少为 1 秒")
	}
	if c.Service.CodexBinary == "" {
		return errors.New("Codex 路径不能为空")
	}
	if !filepath.IsAbs(c.Service.CodexBinary) && strings.ContainsAny(c.Service.CodexBinary, "/\\") {
		return errors.New("Codex 路径应为绝对路径或 PATH 中的程序名")
	}
	if info, e := os.Stat(c.Executable); e != nil || !info.Mode().IsRegular() {
		return errors.New("服务可执行文件不存在")
	}
	return nil
}

func readJSON(path string, value any) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || !platform.PrivateMode(info) || info.Size() > 64<<10 {
		return errors.New("守护文件必须是私有普通文件，且不超过 64 KiB")
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	d := json.NewDecoder(io.LimitReader(f, 64<<10))
	d.DisallowUnknownFields()
	if err = d.Decode(value); err != nil {
		return err
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		return errors.New("守护文件包含多余数据")
	}
	return nil
}

func Load(path string) (Config, error) {
	var c Config
	if err := readJSON(path, &c); err != nil {
		return c, err
	}
	return c, c.Validate()
}

func writeJSON(path string, value any) error {
	b, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".guardian-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(append(b, '\n'))
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = replaceFile(tmp, path); err != nil {
		return err
	}
	return platform.SyncDir(filepath.Dir(path))
}

func randomID() (string, error) {
	var b [24]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

func runDir(path string) string           { return path + ".run" }
func statePath(path string) string        { return filepath.Join(runDir(path), "session.json") }
func recordPath(path, role string) string { return filepath.Join(runDir(path), role+".json") }
func rolePath(path, role string) string   { return filepath.Join(runDir(path), role+".lock") }

func prepare(path string) error {
	if !filepath.IsAbs(path) {
		return errors.New("守护配置必须使用绝对路径")
	}
	if err := os.MkdirAll(runDir(path), 0700); err != nil {
		return err
	}
	info, err := os.Lstat(runDir(path))
	if err != nil {
		return err
	}
	if !info.IsDir() || !platform.PrivateMode(info) {
		return errors.New("守护状态目录权限无效")
	}
	return nil
}

func takeLock(path string) (*os.File, error) {
	if info, err := os.Lstat(path); err == nil && (!info.Mode().IsRegular() || !platform.PrivateMode(info)) {
		return nil, errors.New("锁文件无效")
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = platform.Lock(f); err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}

func controlLock(ctx context.Context, path string) (*os.File, error) {
	for {
		f, err := takeLock(filepath.Join(runDir(path), "control.lock"))
		if err == nil {
			return f, nil
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func vacant(path, role string) bool {
	f, err := takeLock(rolePath(path, role))
	if err != nil {
		return false
	}
	f.Close()
	return true
}

type session struct {
	ID        string `json:"id"`
	Running   bool   `json:"running"`
	RestartsA int    `json:"restartsA"`
	RestartsB int    `json:"restartsB"`
}

func loadSession(path string) (session, error) {
	var s session
	err := readJSON(statePath(path), &s)
	if err == nil && s.ID == "" {
		err = errors.New("守护会话标识为空")
	}
	return s, err
}

type record struct {
	Session  string    `json:"session"`
	Role     string    `json:"role"`
	Instance string    `json:"instance"`
	PID      int       `json:"pid"`
	Birth    string    `json:"birth"`
	Started  time.Time `json:"started"`
}

func loadRecord(path, role string) (record, error) {
	var r record
	var err error
	for _, file := range []string{recordPath(path, role), recordPath(path, role) + ".backup"} {
		r = record{}
		err = readJSON(file, &r)
		if err == nil && (r.Role != role || r.Session == "" || r.PID <= 0 || r.Birth == "" || r.Instance == "" || r.Started.IsZero()) {
			err = errors.New("进程身份记录无效")
		}
		if err == nil {
			return r, nil
		}
	}
	return r, err
}
