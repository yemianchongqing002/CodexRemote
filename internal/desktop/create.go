package desktop

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"time"
)

// Creator uses an isolated official app-server to create and persist a new thread before desktop starts generation.
// Existing desktop threads are never resumed in this subprocess.
type Creator struct {
	Binary, Home string
	Desktop      *Client
	Open         func(context.Context, string) error
}

var threadIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func (c *Creator) Create(ctx context.Context, cwd, text string) (string, error) {
	cmd := exec.CommandContext(ctx, c.Binary, "app-server", "--stdio")
	cmd.Dir = cwd
	cmd.Env = append(os.Environ(), "CODEX_HOME="+c.Home)
	cmd.WaitDelay = 2 * time.Second
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return "", err
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return "", err
	}
	// Do not forward initialization logs or configuration values to the web client.
	cmd.Stderr = io.Discard
	if err = cmd.Start(); err != nil {
		return "", errors.New("无法启动本机 Codex 会话创建器")
	}
	stopped := false
	stopCreator := func() {
		if stopped {
			return
		}
		stopped = true
		stdin.Close()
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		_ = cmd.Wait()
	}
	defer stopCreator()
	scan := bufio.NewScanner(stdout)
	scan.Buffer(make([]byte, 4096), 8<<20)
	seq := 0
	request := func(method string, params any) (json.RawMessage, error) {
		seq++
		data, _ := json.Marshal(map[string]any{"id": seq, "method": method, "params": params})
		if _, e := stdin.Write(append(data, '\n')); e != nil {
			return nil, e
		}
		for scan.Scan() {
			var msg struct {
				ID     *int            `json:"id"`
				Result json.RawMessage `json:"result"`
				Error  json.RawMessage `json:"error"`
				Method string          `json:"method"`
			}
			if json.Unmarshal(scan.Bytes(), &msg) != nil {
				continue
			}
			if msg.ID != nil && *msg.ID == seq && msg.Method == "" {
				if len(msg.Error) > 0 && string(msg.Error) != "null" {
					return nil, fmt.Errorf("创建接口拒绝 %s 请求", method)
				}
				return msg.Result, nil
			}
			// No model turn is started, so approvals are never expected or accepted here.
		}
		return nil, errors.New("创建接口连接结束，结果未确认")
	}
	if _, err = request("initialize", map[string]any{"capabilities": map[string]bool{"experimentalApi": true}, "clientInfo": map[string]string{"name": "codex_remote", "title": "Codex Remote", "version": "0.1.0"}}); err != nil {
		return "", err
	}
	if _, err = stdin.Write([]byte("{\"method\":\"initialized\",\"params\":{}}\n")); err != nil {
		return "", err
	}
	raw, err := request("thread/start", map[string]any{"cwd": cwd, "ephemeral": false})
	if err != nil {
		return "", err
	}
	var result struct {
		Thread struct {
			ID   string `json:"id"`
			Path string `json:"path"`
		} `json:"thread"`
	}
	if json.Unmarshal(raw, &result) != nil || !threadIDPattern.MatchString(result.Thread.ID) {
		return "", errors.New("创建返回无效会话 ID，请核对电脑")
	}
	id := result.Thread.ID
	// Empty threads are not durable in this version. Persist the user's actual first
	// message through the official history API before transferring to desktop.
	if _, err = request("thread/inject_items", map[string]any{"threadId": id, "items": []any{map[string]any{"type": "message", "role": "user", "id": "codex-remote-initial-" + uid(), "content": []any{map[string]string{"type": "input_text", "text": text}}}}}); err != nil {
		return "", errors.New("新会话首条消息保存失败，请核对电脑")
	}

	// Unsubscribe persists history, but the app-server retains its writer lock
	// until exit. Wait for exit before asking desktop to resume this thread.
	if _, err = request("thread/unsubscribe", map[string]string{"threadId": id}); err != nil {
		return id, errors.New("会话已创建，但创建器释放未确认，请在桌面打开")
	}
	if _, err = os.Stat(result.Thread.Path); err != nil {
		return "", errors.New("新会话记录尚未保存，创建结果未确认")
	}
	stopCreator()
	if c.Open != nil {
		if err = c.Open(ctx, id); err != nil {
			return id, errors.New("会话已创建，请在电脑 Codex 中打开后发送")
		}
	}

	if c.Desktop != nil && c.Open != nil {
		ready := false
		for attempt := 0; attempt < 5; attempt++ {
			probeCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
			err = c.Desktop.Probe(probeCtx, id)
			cancel()
			if err == nil {
				ready = true
				break
			}
			select {
			case <-ctx.Done():
				return id, errors.New("会话已创建，等待桌面打开后继续")
			case <-time.After(500 * time.Millisecond):
			}
		}
		if !ready {
			return id, errors.New("会话已创建，首条消息已保存；请在电脑打开后继续")
		}
		result := c.Desktop.Start(ctx, id, uid(), "")
		if result.Status != "accepted" {
			return id, errors.New("会话已创建，首条消息已保存；开始生成的结果：" + result.Detail)
		}
	}
	return id, nil
}
