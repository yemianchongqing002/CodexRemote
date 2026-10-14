package desktop

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
)

// PermissionSelection is the desktop's saved menu choice, separate from the
// thread settings. The follower protocol cannot write this desktop preference.
type PermissionSelection struct {
	AgentMode string `json:"agentMode,omitempty"`
	Source    string `json:"source"`
	CanChange bool   `json:"canChange"`
	Reason    string `json:"reason,omitempty"`
}

const desktopSelectionReason = "会话审批模式可单独修改，不会改变 Codex 桌面选择"

func readPermissionSelection(home string) PermissionSelection {
	unavailable := PermissionSelection{Source: "unavailable", Reason: "无法读取 Codex 当前权限选择，请检查桌面连接后重新同步"}
	if home == "" {
		return unavailable
	}
	f, err := os.Open(filepath.Join(home, ".codex-global-state.json"))
	if err != nil {
		return unavailable
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, (8<<20)+1))
	if err != nil || len(b) > 8<<20 {
		return unavailable
	}
	var state struct {
		Atoms map[string]json.RawMessage `json:"electron-persisted-atom-state"`
	}
	if json.Unmarshal(b, &state) != nil {
		return unavailable
	}
	var choices map[string]string
	if json.Unmarshal(state.Atoms["agent-mode-by-host-id"], &choices) != nil {
		return unavailable
	}
	mode := choices["local"]
	switch mode {
	case "auto", "granular", "guardian-approvals", "full-access", "read-only":
		return PermissionSelection{AgentMode: mode, Source: "desktop-preference", Reason: desktopSelectionReason}
	default:
		return unavailable
	}
}

func (s *LiveState) withPermissionSelection(home string) {
	selection := readPermissionSelection(home)
	s.PermissionSelection = &selection
	// A changed desktop choice invalidates controls even when thread settings
	// have not yet changed. Never overwrite the raw thread permission fields.
	s.PermissionVersion = digest([]any{s.PermissionVersion, selection})
}
