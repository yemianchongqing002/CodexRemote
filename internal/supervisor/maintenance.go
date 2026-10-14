package supervisor

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// A separate fence is readable even when session.json is damaged or a peer
// is frozen while holding control.lock. Only an explicit start clears it.
var ErrStopped = errors.New("守护服务已停止")

func stopPath(path string) string { return filepath.Join(runDir(path), "stopped.json") }
func stopped(path string) bool {
	_, err := os.Lstat(stopPath(path))
	return !os.IsNotExist(err)
}
func requestStop(path string) (string, error) {
	return requestFence(path, "")
}
func requestFence(path, prefix string) (string, error) {
	guard, err := intentLock(path)
	if err != nil {
		return "", err
	}
	defer guard.Close()
	if prefix != "" && stopped(path) {
		var current string
		if err := readJSON(stopPath(path), &current); err != nil || !strings.HasPrefix(current, "repair:") {
			return "", ErrStopped
		}
	}
	id, err := randomID()
	id = prefix + id
	if err == nil {
		err = writeJSON(stopPath(path), id)
	}
	operationTrace("stop_fence_written", "config=%s emergency=%t error=%v", path, prefix != "", err)
	return id, err
}
func clearStop(path string) error {
	guard, err := intentLock(path)
	if err != nil {
		return err
	}
	defer guard.Close()
	return removeStop(path)
}
func removeStop(path string) error {
	err := os.Remove(stopPath(path))
	if os.IsNotExist(err) {
		return nil
	}
	return err
}
func intentLock(path string) (*os.File, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return namedLock(ctx, path, "intent.lock")
}
func operationLock(ctx context.Context, path string) (*os.File, error) {
	return namedLock(ctx, path, "operation.lock")
}
func namedLock(ctx context.Context, path, name string) (*os.File, error) {
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		f, err := takeLock(filepath.Join(runDir(path), name))
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

// Never infer successful shutdown from an unreadable identity file. The role
// lock must be free; otherwise require a birth-verified identity and stop it.
func stopAll(ctx context.Context, path string) error {
	var failures []error
	for _, role := range []string{"B", "A"} {
		if vacant(path, role) {
			continue
		}
		r, err := loadRecord(path, role)
		if err == nil {
			err = stopRole(ctx, path, r)
		}
		if err != nil {
			failures = append(failures, fmt.Errorf("停止 %s: %w", role, err))
		}
	}
	for _, role := range []string{"B", "A"} {
		if !vacant(path, role) {
			failures = append(failures, fmt.Errorf("%s 尚未确认退出", role))
		}
	}
	if len(failures) == 0 {
		if s, err := loadSession(path); err == nil {
			s.Running = false
			if err = writeJSON(statePath(path), s); err != nil {
				failures = append(failures, err)
			}
		}
	}
	return errors.Join(failures...)
}

// Check is called by the system startup wrapper. A single healthy role can
// recover the pair. The wrapper repairs only after three failed samples.
func Check(ctx context.Context, path string) error {
	if stopped(path) {
		var ticket string
		if err := readJSON(stopPath(path), &ticket); err != nil {
			return ErrStopped // An unreadable stop intent must never permit revival.
		}
		if strings.HasPrefix(ticket, "repair:") {
			return errors.New("上次紧急恢复尚未完成")
		}
		return ErrStopped
	}
	s, err := loadSession(path)
	if err != nil {
		return err
	}
	if !s.Running {
		return ErrStopped
	}
	var reasons []error
	for _, role := range []string{"B", "A"} {
		r, err := loadRecord(path, role)
		if err != nil {
			reasons = append(reasons, fmt.Errorf("%s 身份记录: %w", role, err))
			continue
		}
		if r.Session != s.ID || vacant(path, role) {
			reasons = append(reasons, fmt.Errorf("%s 不在当前会话中运行", role))
			continue
		}
		if err = peerHealthError(ctx, path, r); err == nil || time.Since(r.Started) < startupGrace {
			return nil
		}
		reasons = append(reasons, fmt.Errorf("%s pid=%d: %w", role, r.PID, err))
	}
	return fmt.Errorf("A、B 均未响应健康检查: %w", errors.Join(reasons...))
}

// Repair is an emergency system-wrapper operation. It fences and reclaims
// both roles without control.lock, then starts only B. B always replaces A.
func Repair(ctx context.Context, path string) (result error) {
	started := time.Now()
	operationTrace("repair_begin", "config=%s reason=external_watchdog", path)
	defer func() {
		operationTrace("repair_end", "config=%s elapsed=%s error=%v", path, time.Since(started), result)
	}()
	if err := prepare(path); err != nil {
		return err
	}
	guard, err := operationLock(ctx, path)
	if err != nil {
		return err
	}
	defer guard.Close()
	if err = Check(ctx, path); err == nil || errors.Is(err, ErrStopped) {
		operationTrace("repair_skipped", "config=%s healthy=%t stopped=%t", path, err == nil, errors.Is(err, ErrStopped))
		return err
	}
	operationTrace("repair_confirmed", "config=%s error=%v", path, err)
	cfg, err := Load(path)
	if err != nil {
		return err
	}
	ticket, err := requestFence(path, "repair:")
	if err != nil {
		return err
	}
	if err = stopAll(ctx, path); err != nil {
		return err
	}
	intent, err := intentLock(path)
	if err != nil {
		return err
	}
	defer intent.Close()
	var current string
	if err = readJSON(stopPath(path), &current); err != nil {
		return err
	}
	if current != ticket {
		operationTrace("repair_cancelled", "config=%s reason=concurrent_explicit_stop", path)
		return ErrStopped // A concurrent explicit stop takes precedence.
	}
	id, err := randomID()
	if err != nil {
		return err
	}
	if err = writeJSON(statePath(path), session{ID: id, Running: true}); err != nil {
		return err
	}
	if err = removeStop(path); err != nil {
		return err
	}
	cmd := exec.Command(cfg.Executable, "--guardian-role=B", "--guardian-config="+path, "--guardian-session="+id)
	cmd.Dir = filepath.Dir(cfg.Executable)
	cmd.SysProcAttr = childAttrs()
	// Do not inherit the short-lived check/repair command's output pipe:
	// shells would wait for EOF for the entire lifetime of the new B.
	output, err := os.OpenFile(filepath.Join(runDir(path), "recovery.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer output.Close()
	cmd.Stdout, cmd.Stderr = output, output
	if err = cmd.Start(); err != nil {
		return err
	}
	operationTrace("repair_child_spawned", "config=%s role=B pid=%d session=%s readiness=pending log=%s", path, cmd.Process.Pid, id, output.Name())
	return cmd.Process.Release()
}
