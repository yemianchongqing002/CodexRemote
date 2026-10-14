package desktop

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPermissionSelectionOverridesDisplayOnly(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, ".codex-global-state.json")
	write := func(mode string) {
		t.Helper()
		if err := os.WriteFile(path, []byte(`{"electron-persisted-atom-state":{"agent-mode-by-host-id":{"local":"`+mode+`"}}}`), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write("full-access")
	beforeBytes, _ := os.ReadFile(path)
	state := parsedFixture(t, liveFixture("command"))
	rawPolicy := string(state.ApprovalPolicy)
	state.withPermissionSelection(home)
	if state.PermissionSelection.AgentMode != "full-access" || state.PermissionSelection.CanChange || state.PermissionSelection.Source != "desktop-preference" {
		t.Fatal(state.PermissionSelection)
	}
	if string(state.ApprovalPolicy) != rawPolicy || state.ApprovalsReviewer != "user" {
		t.Fatal("overwrote thread settings")
	}
	afterBytes, _ := os.ReadFile(path)
	if string(beforeBytes) != string(afterBytes) {
		t.Fatal("changed desktop state")
	}
	write("guardian-approvals")
	next := parsedFixture(t, liveFixture("command"))
	next.withPermissionSelection(home)
	if state.PermissionVersion == next.PermissionVersion {
		t.Fatal("desktop choice missing from version")
	}
	if next.PermissionSelection.AgentMode != "guardian-approvals" {
		t.Fatal(next.PermissionSelection)
	}
}

func TestPermissionSelectionUnavailable(t *testing.T) {
	for _, content := range []string{"", "{", `{}`, `{"electron-persisted-atom-state":{"agent-mode-by-host-id":{"local":"custom"}}}`, `{"electron-persisted-atom-state":{"agent-mode-by-host-id":{"remote":"full-access"}}}`} {
		home := t.TempDir()
		if content != "" {
			if err := os.WriteFile(filepath.Join(home, ".codex-global-state.json"), []byte(content), 0600); err != nil {
				t.Fatal(err)
			}
		}
		selection := readPermissionSelection(home)
		if selection.Source != "unavailable" || selection.AgentMode != "" || selection.CanChange || selection.Reason == "" {
			t.Fatal(selection)
		}
	}
}
