package supervisor

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"
)

func TestStopWorksWithDamagedSessionAndHeldControlLock(t *testing.T) {
	path, _ := fixture(t)
	if err := os.WriteFile(statePath(path), []byte("broken"), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	lock, err := controlLock(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if err = Stop(ctx, path); err != nil {
		t.Fatal(err)
	}
	if err = Check(ctx, path); !errors.Is(err, ErrStopped) {
		t.Fatal("stop fence must survive damaged session", err)
	}
}

func TestStopCannotReportSuccessForUnidentifiedOccupiedRole(t *testing.T) {
	path, _ := fixture(t)
	lock, err := takeLock(rolePath(path, "A"))
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err = Stop(ctx, path); err == nil {
		t.Fatal("occupied role without identity was reported stopped")
	}
	if !stopped(path) {
		t.Fatal("failed cleanup must still prevent revival")
	}
}

func TestExplicitStopWinsOverEmergencyRepair(t *testing.T) {
	path, _ := fixture(t)
	if _, err := requestFence(path, "repair:"); err != nil {
		t.Fatal(err)
	}
	if err := Check(context.Background(), path); errors.Is(err, ErrStopped) || err == nil {
		t.Fatal("unfinished repair must remain retryable", err)
	}
	if _, err := requestStop(path); err != nil {
		t.Fatal(err)
	}
	if _, err := requestFence(path, "repair:"); !errors.Is(err, ErrStopped) {
		t.Fatal("repair overwrote explicit stop", err)
	}
	if err := Repair(context.Background(), path); !errors.Is(err, ErrStopped) {
		t.Fatal("repair ignored explicit stop", err)
	}
}

func TestDamagedRecordUsesBackup(t *testing.T) {
	path, _ := fixture(t)
	r := record{Session: "session", Role: "B", PID: os.Getpid(), Birth: "birth", Instance: "instance", Started: time.Now().UTC()}
	if err := writeJSON(recordPath(path, "B")+".backup", r); err != nil {
		t.Fatal(err)
	}
	for _, damaged := range []string{"broken", "{}"} {
		if err := os.WriteFile(recordPath(path, "B"), []byte(damaged), 0600); err != nil {
			t.Fatal(err)
		}
		got, err := loadRecord(path, "B")
		if err != nil || got.Instance != r.Instance {
			t.Fatal("backup identity not recovered", err)
		}
	}
}
