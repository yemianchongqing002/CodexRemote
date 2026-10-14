package desktop

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
)

type streamFrame struct {
	Type    string `json:"type"`
	Method  string `json:"method"`
	Source  string `json:"sourceClientId"`
	Version int    `json:"version"`
	Params  struct {
		Host   string `json:"hostId"`
		Thread string `json:"conversationId"`
		Change struct {
			Type  string          `json:"type"`
			State json.RawMessage `json:"conversationState"`
		} `json:"change"`
	} `json:"params"`
}

func (w *wire) follow(thread, owner string, following bool) error {
	_, err := w.writeFrame(map[string]any{"type": "broadcast", "sourceClientId": w.client, "targetClientIds": []string{owner}, "method": "thread-stream-following-changed", "version": 1, "params": map[string]any{"hostId": "local", "conversationId": thread, "following": following}})
	return err
}

// Request a new snapshot on demand. No writer ownership or thread resume occurs.
func (w *wire) snapshot(thread, owner string) (LiveState, error) {
	if err := w.follow(thread, owner, true); err != nil {
		return LiveState{}, err
	}
	for {
		var size [4]byte
		if _, err := io.ReadFull(w.conn, size[:]); err != nil {
			return LiveState{}, errors.New("读取桌面实时状态失败，请在电脑打开该聊天后重试")
		}
		n := binary.LittleEndian.Uint32(size[:])
		if n == 0 || n > 32<<20 {
			return LiveState{}, errors.New("桌面会话快照超出读取限制")
		}
		b := make([]byte, n)
		if _, err := io.ReadFull(w.conn, b); err != nil {
			return LiveState{}, err
		}
		var f streamFrame
		if json.Unmarshal(b, &f) != nil {
			return LiveState{}, errors.New("桌面实时状态格式不兼容")
		}
		if f.Type != "broadcast" || f.Method != "thread-stream-state-changed" || f.Source != owner || f.Params.Thread != thread || f.Params.Host != "local" {
			continue
		}
		if f.Version != 11 {
			return LiveState{}, errors.New("当前桌面的实时状态协议版本不支持")
		}
		if f.Params.Change.Type != "snapshot" {
			continue
		}
		state, err := parseLive(thread, f.Params.Change.State)
		if err == nil {
			state.withPermissionSelection(w.home)
		}
		return state, err
	}
}
