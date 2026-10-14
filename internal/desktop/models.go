package desktop

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

type ReasoningOption struct {
	Effort      string `json:"reasoningEffort"`
	Description string `json:"description"`
}
type ServiceTier struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
}
type Model struct {
	ID            string            `json:"id"`
	Model         string            `json:"model"`
	DisplayName   string            `json:"displayName"`
	Description   string            `json:"description"`
	Hidden        bool              `json:"hidden"`
	Efforts       []ReasoningOption `json:"supportedReasoningEfforts"`
	DefaultEffort string            `json:"defaultReasoningEffort"`
	Tiers         []ServiceTier     `json:"serviceTiers"`
	IsDefault     bool              `json:"isDefault"`
}
type ModelSettings struct {
	Model  string `json:"model"`
	Effort string `json:"effort"`
	Fast   bool   `json:"fast"`
}

func ValidateModelSettings(models []Model, choice ModelSettings) error {
	for _, m := range models {
		if m.Hidden || m.Model != choice.Model {
			continue
		}
		validEffort := false
		for _, e := range m.Efforts {
			if e.Effort == choice.Effort {
				validEffort = true
			}
		}
		if !validEffort {
			return errors.New("该模型不支持所选思考深度，请刷新模型列表")
		}
		if choice.Fast {
			for _, tier := range m.Tiers {
				if tier.ID == "priority" {
					return nil
				}
			}
			return errors.New("该模型未提供 Fast 模式")
		}
		return nil
	}
	return errors.New("目标电脑未提供所选模型，请刷新模型列表")
}

// Catalog starts a short-lived discovery process only on demand. It never
// starts/resumes a thread or starts a model turn, and caches for five minutes.
type Catalog struct {
	Binary, Home string
	mu           sync.Mutex
	models       []Model
	loaded       time.Time
}

func (c *Catalog) List(ctx context.Context) ([]Model, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if len(c.models) > 0 && time.Since(c.loaded) < 5*time.Minute {
		return c.models, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, c.Binary, "app-server", "--stdio")
	hideCatalogWindow(cmd)
	for _, item := range os.Environ() {
		if !strings.HasPrefix(strings.ToUpper(item), "CODEX_HOME=") {
			cmd.Env = append(cmd.Env, item)
		}
	}
	cmd.Env = append(cmd.Env, "CODEX_HOME="+c.Home)
	cmd.Stderr = io.Discard
	cmd.WaitDelay = time.Second
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	if err = cmd.Start(); err != nil {
		return nil, errors.New("无法启动目标电脑的 Codex 模型查询，请检查 --codex-binary")
	}
	defer func() { in.Close(); _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	scan := bufio.NewScanner(io.LimitReader(out, 8<<20))
	scan.Buffer(make([]byte, 4096), 2<<20)
	seq := 0
	rpc := func(method string, params any) (json.RawMessage, error) {
		seq++
		if err := json.NewEncoder(in).Encode(map[string]any{"id": seq, "method": method, "params": params}); err != nil {
			return nil, err
		}
		for scan.Scan() {
			var r struct {
				ID     int             `json:"id"`
				Result json.RawMessage `json:"result"`
				Error  json.RawMessage `json:"error"`
			}
			if json.Unmarshal(scan.Bytes(), &r) != nil || r.ID != seq {
				continue
			}
			if len(r.Error) > 0 && string(r.Error) != "null" {
				return nil, errors.New("目标 Codex 不支持模型查询或当前账号不可用")
			}
			return r.Result, nil
		}
		return nil, errors.New("模型查询中断或超时，请稍后重试")
	}
	if _, err = rpc("initialize", map[string]any{"clientInfo": map[string]string{"name": "codex_remote_models", "version": "0.1.0"}, "capabilities": map[string]bool{"experimentalApi": true}}); err != nil {
		return nil, err
	}
	if err = json.NewEncoder(in).Encode(map[string]any{"method": "initialized", "params": map[string]any{}}); err != nil {
		return nil, err
	}
	var models []Model
	var cursor *string
	for page := 0; page < 10; page++ {
		raw, err := rpc("model/list", map[string]any{"includeHidden": false, "cursor": cursor, "limit": 100})
		if err != nil {
			return nil, err
		}
		var result struct {
			Data       []Model `json:"data"`
			NextCursor *string `json:"nextCursor"`
		}
		if json.Unmarshal(raw, &result) != nil {
			return nil, errors.New("模型列表格式不兼容")
		}
		for _, m := range result.Data {
			if !m.Hidden && m.Model != "" {
				models = append(models, m)
			}
		}
		cursor = result.NextCursor
		if cursor == nil {
			break
		}
	}
	if cursor != nil || len(models) == 0 {
		return nil, errors.New("未能读取完整可用模型列表")
	}
	c.models, c.loaded = models, time.Now()
	return models, nil
}
