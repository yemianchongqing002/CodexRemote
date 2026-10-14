package main

import (
	"path/filepath"
	"testing"
)

func TestTokenSurvivesRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state", "token")
	first, err := loadToken(path)
	if err != nil {
		t.Fatal(err)
	}
	second, err := loadToken(path)
	if err != nil {
		t.Fatal(err)
	}
	if first != second || len(first) < 32 {
		t.Fatal("token changed or too short")
	}
}
