package desktop

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"testing"
	"time"

	"codexremote/internal/chat"
)

// Opt-in compatibility check with the installed binary, isolated from user history.
// Does not open desktop or start model generation.
func TestCreateWithLocalBinary(t *testing.T) {
	binary := os.Getenv("CODEX_REMOTE_TEST_BINARY")
	if binary == "" {
		t.Skip("set CODEX_REMOTE_TEST_BINARY for local protocol verification")
	}
	home := t.TempDir()
	c := &Creator{Binary: binary, Home: home}
	// A second process must acquire ownership DURING handoff, before Create returns.
	c.Open = func(ctx context.Context, id string) error {
		cmd := exec.CommandContext(ctx, binary, "app-server", "--stdio")
		cmd.Env = append(os.Environ(), "CODEX_HOME="+home)
		cmd.Stderr = io.Discard
		stdout, err := cmd.StdoutPipe()
		if err != nil {
			return err
		}
		stdin, err := cmd.StdinPipe()
		if err != nil {
			return err
		}
		if err = cmd.Start(); err != nil {
			return err
		}
		defer func() { stdin.Close(); cmd.Process.Kill(); cmd.Wait() }()
		enc := json.NewEncoder(stdin)
		scan := bufio.NewScanner(stdout)
		scan.Buffer(make([]byte, 4096), 8<<20)
		call := func(n int, method string, params any) error {
			if err := enc.Encode(map[string]any{"id": n, "method": method, "params": params}); err != nil {
				return err
			}
			for scan.Scan() {
				var msg struct {
					ID    int             `json:"id"`
					Error json.RawMessage `json:"error"`
				}
				if json.Unmarshal(scan.Bytes(), &msg) == nil && msg.ID == n {
					if len(msg.Error) > 0 && string(msg.Error) != "null" {
						return fmt.Errorf("%s: %s", method, msg.Error)
					}
					return nil
				}
			}
			return fmt.Errorf("%s: connection ended", method)
		}
		if err = call(1, "initialize", map[string]any{"clientInfo": map[string]string{"name": "handoff_test", "version": "1"}}); err != nil {
			return err
		}
		return call(2, "thread/resume", map[string]any{"threadId": id})
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	id, err := c.Create(ctx, home, "隔离的新会话首条消息测试")
	if err != nil {
		t.Fatal(err)
	}
	store, err := chat.New(home)
	if err != nil {
		t.Fatal(err)
	}
	store.Refresh(true)
	page, ok := store.Read(id, "", "", 50)
	if !ok || len(page.Messages) != 1 || page.Messages[0].Text != "隔离的新会话首条消息测试" {
		t.Fatalf("first message was not persisted: %+v", page)
	}
}
