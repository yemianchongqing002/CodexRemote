package supervisor

import (
	"codexremote/internal/localtls"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const checkInterval = 30 * time.Second
const failureLimit = 3
const startupGrace = 90 * time.Second

type Peer struct {
	path, role  string
	self        record
	ctx         context.Context
	cancel      context.CancelFunc
	signal      context.Context
	lock        *os.File
	listener    net.Listener
	mu          sync.Mutex
	health      func()
	ready       bool
	lastTick    time.Time
	lastRestart time.Time
	restart     chan struct{}
	monitorDone chan struct{}
	halted      atomic.Bool
	closeOnce   sync.Once
}

type request struct {
	Session  string `json:"session"`
	Instance string `json:"instance"`
	Method   string `json:"method"`
}
type response struct {
	Session  string `json:"session"`
	Instance string `json:"instance"`
	Role     string `json:"role"`
	PID      int    `json:"pid"`
	Healthy  bool   `json:"healthy"`
	Error    string `json:"error,omitempty"`
}

// Boot is the system/manual entry into B. An existing session is never
// overwritten while A is alive; a recovered B must consume the saved config.
func Boot(signal context.Context, path string, cfg Config) error {
	if err := cfg.Validate(); err != nil {
		return err
	}
	if err := prepare(path); err != nil {
		return err
	}
	operation, err := operationLock(signal, path)
	if err != nil {
		return err
	}
	defer operation.Close()
	ctx, cancel := context.WithTimeout(signal, 5*time.Second)
	defer cancel()
	guard, err := controlLock(ctx, path)
	if err != nil {
		return err
	}
	bLock, err := takeLock(rolePath(path, "B"))
	if err != nil {
		guard.Close()
		return errors.New("B 已运行")
	}
	s, err := loadSession(path)
	if !vacant(path, "A") {
		if err != nil || !s.Running {
			bLock.Close()
			guard.Close()
			return errors.New("A 正在停止，请稍后启动")
		}
		if _, err = Load(path); err != nil {
			bLock.Close()
			guard.Close()
			return err
		}
	} else {
		id, e := randomID()
		if e != nil {
			bLock.Close()
			guard.Close()
			return e
		}
		s = session{ID: id, Running: true}
		if err = writeJSON(path, cfg); err == nil {
			err = writeJSON(statePath(path), s)
		}
		if err != nil {
			bLock.Close()
			guard.Close()
			return err
		}
	}
	if err = clearStop(path); err != nil {
		bLock.Close()
		guard.Close()
		return err
	}
	p, err := newPeer(signal, path, "B", s.ID, bLock)
	guard.Close()
	operation.Close()
	if err != nil {
		return err
	}
	return runB(p)
}

// Join is only invoked with a config path, role and current session ID.
func Join(signal context.Context, path, role, id string) (*Peer, error) {
	if role != "A" && role != "B" {
		return nil, errors.New("无效守护角色")
	}
	if err := prepare(path); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(signal, 10*time.Second)
	defer cancel()
	guard, err := controlLock(ctx, path)
	if err != nil {
		return nil, err
	}
	defer guard.Close()
	s, err := loadSession(path)
	if err != nil {
		return nil, err
	}
	if stopped(path) || !s.Running || s.ID != id {
		return nil, errors.New("守护会话已停止或已更换")
	}
	if _, err = Load(path); err != nil {
		return nil, err
	}
	lock, err := takeLock(rolePath(path, role))
	if err != nil {
		return nil, errors.New("该角色已运行")
	}
	return newPeer(signal, path, role, id, lock)
}

func newPeer(signal context.Context, path, role, id string, lock *os.File) (*Peer, error) {
	instance, err := randomID()
	if err != nil {
		lock.Close()
		return nil, err
	}
	birth, err := processBirth(os.Getpid())
	if err != nil {
		lock.Close()
		return nil, err
	}
	l, err := listenIPC(path, role)
	if err != nil {
		lock.Close()
		return nil, err
	}
	ctx, cancel := context.WithCancel(signal)
	p := &Peer{path: path, role: role, ctx: ctx, cancel: cancel, signal: signal, lock: lock, listener: l, lastTick: time.Now(), restart: make(chan struct{}, 1), monitorDone: make(chan struct{})}
	p.self = record{Session: id, Role: role, Instance: instance, PID: os.Getpid(), Birth: birth, Started: time.Now().UTC()}
	if err = writeJSON(recordPath(path, role)+".backup", p.self); err == nil {
		err = writeJSON(recordPath(path, role), p.self)
	}
	if err != nil {
		l.Close()
		lock.Close()
		cancel()
		return nil, err
	}
	if stopped(path) {
		l.Close()
		lock.Close()
		cancel()
		return nil, ErrStopped
	}
	go p.serve()
	trace(p.self, "role_started", "config=%s check_interval=%s failure_limit=%d startup_grace=%s", path, checkInterval, failureLimit, startupGrace)
	return p, nil
}

func RunGuardian(signal context.Context, path, id string) error {
	p, err := Join(signal, path, "B", id)
	if err != nil {
		return err
	}
	return runB(p)
}

func runB(p *Peer) error {
	p.Ready(nil)
	trace(p.self, "restart_trigger", "target=A reason=B_started")
	// Every B startup, including A's recovery of B, replaces A from the config.
	// The recovery mutex is released by the spawner before B acquires it here.
	if err := p.recover("A", true); err != nil {
		log.Printf("B 启动时恢复 A 失败: %v", err)
	}
	p.StartMonitor()
	defer p.Close()
	<-p.ctx.Done()
	return nil
}

func (p *Peer) Context() context.Context { return p.ctx }
func (p *Peer) Ready(health func()) {
	p.mu.Lock()
	p.health = health
	p.ready = true
	p.mu.Unlock()
	trace(p.self, "role_ready", "服务初始化完成")
}
func (p *Peer) StartMonitor() { go func() { defer close(p.monitorDone); p.monitor() }() }
func (p *Peer) Close() {
	p.closeOnce.Do(func() {
		trace(p.self, "role_closing", "开始退出清理")
		p.halted.Store(true)
		p.cancel()
		<-p.monitorDone
		p.listener.Close()
		p.lock.Close()
		trace(p.self, "role_closed", "管理监听和角色锁已释放")
	})
}

func (p *Peer) serve() {
	slots := make(chan struct{}, 8)
	for {
		conn, err := p.listener.Accept()
		if err != nil {
			return
		}
		select {
		case slots <- struct{}{}:
			go func() { defer func() { <-slots }(); p.handle(conn) }()
		default:
			conn.Close()
		}
	}
}

func (p *Peer) handle(conn net.Conn) {
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(4 * time.Second))
	var r request
	if json.NewDecoder(io.LimitReader(conn, 4096)).Decode(&r) != nil || r.Session != p.self.Session || r.Instance != p.self.Instance {
		return
	}
	s, err := loadSession(p.path)
	if r.Method != "halt" && (err != nil || s.ID != r.Session) {
		return
	}
	out := response{Session: p.self.Session, Instance: p.self.Instance, Role: p.role, PID: p.self.PID}
	switch r.Method {
	case "health":
		out.Healthy = !stopped(p.path) && s.Running && p.healthy()
	case "halt":
		trace(p.self, "halt_received", "收到管理通道退出请求")
		p.halted.Store(true)
		// Reply before shutdown closes the public listener and the role lock.
		_ = json.NewEncoder(conn).Encode(out)
		p.cancel()
		return
	case "restart-service":
		if p.role != "B" || stopped(p.path) || !s.Running || p.halted.Load() {
			out.Error = "B 无法接受重启请求"
			break
		}
		p.mu.Lock()
		if time.Since(p.lastRestart) < 15*time.Second {
			out.Error = "重启已在处理中"
		} else {
			select {
			case p.restart <- struct{}{}:
				p.lastRestart = time.Now()
			default:
				out.Error = "重启已在处理中"
			}
		}
		p.mu.Unlock()
		trace(p.self, "restart_request", "target=A accepted=%t error=%s", out.Error == "", out.Error)
	default:
		out.Error = "不支持的管理命令"
	}
	_ = json.NewEncoder(conn).Encode(out)
}

func exchange(ctx context.Context, path string, r record, method string) (response, error) {
	var out response
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	conn, err := dialIPC(ctx, path, r.Role)
	if err != nil {
		return out, err
	}
	defer conn.Close()
	deadline, _ := ctx.Deadline()
	_ = conn.SetDeadline(deadline)
	if err = json.NewEncoder(conn).Encode(request{Session: r.Session, Instance: r.Instance, Method: method}); err != nil {
		return out, err
	}
	if err = json.NewDecoder(io.LimitReader(conn, 4096)).Decode(&out); err != nil {
		return out, err
	}
	if out.Session != r.Session || out.Instance != r.Instance || out.Role != r.Role || out.PID != r.PID {
		return out, errors.New("管理端身份不匹配")
	}
	if out.Error != "" {
		return out, errors.New(out.Error)
	}
	return out, nil
}

type detector struct {
	failures int
	last     time.Time
}

func (p *Peer) healthy() bool {
	p.mu.Lock()
	ready, health, tick := p.ready, p.health, p.lastTick
	p.mu.Unlock()
	if p.halted.Load() || !ready || time.Since(tick) >= startupGrace {
		return false
	}
	if health != nil {
		health()
	}
	return true
}

// A's HTTP loop must respond too; a live management pipe alone is insufficient.
func (p *Peer) HTTPHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" || subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+p.self.Instance)) != 1 {
		http.NotFound(w, r)
		return
	}
	if !p.healthy() {
		http.Error(w, "not ready", 503)
		return
	}
	w.Header().Set("X-Guardian-Instance", p.self.Instance)
	w.WriteHeader(204)
}

func peerHealthy(ctx context.Context, path string, r record) bool {
	return peerHealthError(ctx, path, r) == nil
}

func peerHealthError(ctx context.Context, path string, r record) error {
	v, err := exchange(ctx, path, r, "health")
	if err != nil {
		return fmt.Errorf("IPC 健康检查: %w", err)
	}
	if !v.Healthy {
		return errors.New("对方报告未就绪、正在停止或监控心跳过期")
	}
	if r.Role != "A" {
		return nil
	}
	cfg, err := Load(path)
	if err != nil {
		return fmt.Errorf("读取健康检查配置: %w", err)
	}
	host, port, err := net.SplitHostPort(cfg.Service.Listen)
	if err != nil {
		return fmt.Errorf("解析健康检查地址: %w", err)
	}
	if host == "" || host == "0.0.0.0" {
		host = "127.0.0.1"
	}
	if host == "::" {
		host = "::1"
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	scheme := "http"
	if cfg.Service.TLS {
		scheme = "https"
	}
	req, err := http.NewRequestWithContext(ctx, "GET", scheme+"://"+net.JoinHostPort(host, port)+"/internal/guardian/health", nil)
	if err != nil {
		return fmt.Errorf("构造 HTTP 健康检查: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+r.Instance)
	transport := &http.Transport{Proxy: nil, DisableKeepAlives: true}
	if cfg.Service.TLS {
		transport.TLSClientConfig, err = localtls.Client(cfg.Service.TokenFile + ".tls-key.pem")
		if err != nil {
			return err
		}
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("HTTP 健康检查: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 204 {
		return fmt.Errorf("HTTP 健康检查状态码=%d", resp.StatusCode)
	}
	if resp.Header.Get("X-Guardian-Instance") != r.Instance {
		return errors.New("HTTP 健康检查进程身份不匹配")
	}
	return nil
}

func (d *detector) observe(now time.Time, healthy bool) bool {
	if !d.last.IsZero() && now.Sub(d.last) > 45*time.Second {
		d.failures = 0
	}
	d.last = now
	if healthy {
		d.failures = 0
	} else {
		d.failures++
	}
	return d.failures >= failureLimit
}

func (p *Peer) monitor() {
	other := "A"
	if p.role == "A" {
		other = "B"
	}
	timer := time.NewTicker(checkInterval)
	defer timer.Stop()
	d := detector{}
	for {
		select {
		case <-p.ctx.Done():
			trace(p.self, "monitor_stopping", "system_signal=%t", p.signal.Err() != nil)
			if p.signal.Err() != nil {
				ctx, cancel := context.WithTimeout(context.Background(), 65*time.Second)
				if err := markStopped(ctx, p.path, p.self.Session); err != nil {
					log.Printf("记录停止状态失败: %v", err)
				}
				cancel()
			}
			return
		case <-p.restart:
			trace(p.self, "restart_trigger", "target=A reason=client_request")
			p.touch()
			if err := p.recover("A", true); err != nil {
				log.Printf("重启 A 失败: %v", err)
			}
			p.touch()
			d = detector{}
		case <-timer.C:
			now := time.Now()
			p.touch()
			if stopped(p.path) {
				trace(p.self, "stop_fence_observed", "停止自动恢复并退出")
				p.cancel()
				return
			}
			s, err := loadSession(p.path)
			if err != nil {
				log.Printf("读取守护状态失败: %v", err)
				p.cancel()
				return
			}
			if !s.Running || s.ID != p.self.Session {
				trace(p.self, "session_inactive", "running=%t session_changed=%t", s.Running, s.ID != p.self.Session)
				p.cancel()
				return
			}
			r, err := loadRecord(p.path, other)
			healthy := false
			probeErr := err
			if err == nil && r.Session == s.ID {
				probeErr = peerHealthError(p.ctx, p.path, r)
				healthy = probeErr == nil
				// A freshly started peer gets time to initialize, even if not ready.
				if !healthy && time.Since(r.Started) < startupGrace {
					d = detector{}
					continue
				}
			} else if err == nil {
				probeErr = errors.New("对方会话不匹配")
			}
			if !d.last.IsZero() && now.Sub(d.last) > 45*time.Second {
				trace(p.self, "health_counter_reset", "target=%s reason=check_gap gap=%s", other, now.Sub(d.last))
			}
			previousFailures := d.failures
			needsRecovery := d.observe(now, healthy)
			if !healthy {
				trace(p.self, "health_failed", "target=%s target_pid=%d failures=%d/%d error=%v", other, r.PID, d.failures, failureLimit, probeErr)
			} else if previousFailures > 0 {
				trace(p.self, "health_restored", "target=%s target_pid=%d", other, r.PID)
			}
			if needsRecovery {
				trace(p.self, "restart_trigger", "target=%s reason=health_failure_limit", other)
				if err := p.recover(other, false); err != nil {
					log.Printf("恢复 %s 失败: %v", other, err)
				}
				p.touch()
				d = detector{}
			}
		}
	}
}

func (p *Peer) touch() { p.mu.Lock(); p.lastTick = time.Now(); p.mu.Unlock() }

func (p *Peer) recover(role string, force bool) (err error) {
	started := time.Now()
	trace(p.self, "recovery_begin", "target=%s force=%t", role, force)
	defer func() {
		trace(p.self, "recovery_end", "target=%s elapsed=%s error=%v", role, time.Since(started), err)
	}()
	return p.recoverPeer(role, force, true)
}

func (p *Peer) recoverPeer(role string, force, rescueAllowed bool) error {
	ctx, cancel := context.WithTimeout(p.ctx, 65*time.Second)
	defer cancel()
	lockCtx, release := context.WithTimeout(ctx, 5*time.Second)
	guard, err := controlLock(lockCtx, p.path)
	release()
	if err != nil {
		// A stalled peer may itself own control.lock. Recovery must not need
		trace(p.self, "control_lock_failed", "target=%s error=%v", role, err)
		// that lock in order to terminate its verified, unhealthy owner.
		if !rescueAllowed || p.ctx.Err() != nil || stopped(p.path) {
			return err
		}
		if _, e := Load(p.path); e != nil {
			return e
		}
		r, e := loadRecord(p.path, role)
		if e != nil || r.Session != p.self.Session || peerHealthy(p.ctx, p.path, r) {
			return err
		}
		rescue, done := context.WithTimeout(p.ctx, 65*time.Second)
		trace(p.self, "emergency_reclaim", "target=%s target_pid=%d reason=control_lock_unavailable_and_peer_unhealthy", role, r.PID)
		defer done()
		if e = stopRole(rescue, p.path, r); e != nil {
			return e
		}
		return p.recoverPeer(role, force, false)
	}
	defer guard.Close()
	s, err := loadSession(p.path)
	if err != nil {
		return err
	}
	if stopped(p.path) || !s.Running || s.ID != p.self.Session || p.halted.Load() {
		return errors.New("守护会话正在停止")
	}
	// Validate the new settings before stopping the existing process.
	cfg, err := Load(p.path)
	if err != nil {
		return err
	}
	if !vacant(p.path, role) {
		r, err := loadRecord(p.path, role)
		if err != nil {
			return err
		}
		if r.Session != s.ID {
			return errors.New("另一个守护会话仍占用角色")
		}
		if !force {
			if peerHealthy(ctx, p.path, r) {
				return nil
			}
		}
		if err = stopRole(ctx, p.path, r); err != nil {
			return err
		}
	}
	if stopped(p.path) {
		return errors.New("守护会话正在停止")
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	// A role starts from only a path and identity, never inherited business argv.
	cmd := exec.Command(cfg.Executable, "--guardian-role="+role, "--guardian-config="+p.path, "--guardian-session="+s.ID)
	cmd.Dir = filepath.Dir(cfg.Executable)
	for _, v := range os.Environ() {
		if !strings.HasPrefix(strings.ToUpper(v), "CODEX_REMOTE_GUARDIAN_") {
			cmd.Env = append(cmd.Env, v)
		}
	}
	cmd.SysProcAttr = childAttrs()
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err = cmd.Start(); err != nil {
		return err
	}
	trace(p.self, "child_spawned", "target=%s target_pid=%d readiness=pending", role, cmd.Process.Pid)
	go func() {
		err := cmd.Wait()
		trace(p.self, "child_exited", "target=%s target_pid=%d error=%v", role, cmd.Process.Pid, err)
	}()
	if role == "A" {
		s.RestartsA++
	} else {
		s.RestartsB++
	}
	if err = writeJSON(statePath(p.path), s); err != nil {
		log.Printf("记录重启次数失败: %v", err)
	}
	return nil
}

func stopRole(ctx context.Context, path string, r record) (result error) {
	started := time.Now()
	trace(r, "reclaim_begin", "controller_pid=%d", os.Getpid())
	defer func() {
		trace(r, "reclaim_end", "controller_pid=%d elapsed=%s error=%v", os.Getpid(), time.Since(started), result)
	}()
	if vacant(path, r.Role) {
		return nil
	}
	ref, err := openProcess(r)
	if err != nil {
		// A stale identity is not permission to terminate a reused PID.
		if vacant(path, r.Role) {
			return nil
		}
		return errors.New("无法确认待停止进程身份")
	}
	defer ref.close()
	if _, err = exchange(ctx, path, r, "halt"); err != nil {
		trace(r, "halt_unacknowledged", "controller_pid=%d error=%v", os.Getpid(), err)
	}
	deadline := time.Now().Add(55 * time.Second)
	for !vacant(path, r.Role) {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if time.Now().After(deadline) {
			trace(r, "force_terminate", "controller_pid=%d reason=graceful_exit_timeout timeout=55s", os.Getpid())
			if err = ref.kill(); err != nil {
				return err
			}
			return waitVacant(ctx, path, r.Role)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(200 * time.Millisecond):
		}
	}
	return nil
}

func waitVacant(ctx context.Context, path, role string) error {
	for !vacant(path, role) {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(200 * time.Millisecond):
		}
	}
	return nil
}

// markStopped is the durable fence: neither peer may revive the other afterwards.
func markStopped(ctx context.Context, path, id string) error {
	if _, err := requestStop(path); err != nil {
		return err
	}
	guard, err := controlLock(ctx, path)
	if err != nil {
		return err
	}
	s, err := loadSession(path)
	if err == nil && s.ID == id {
		s.Running = false
		err = writeJSON(statePath(path), s)
	}
	guard.Close()
	if err != nil {
		return err
	}
	for _, role := range []string{"A", "B"} {
		if r, e := loadRecord(path, role); e == nil && r.Session == id {
			_, _ = exchange(ctx, path, r, "halt")
		}
	}
	return nil
}

// Stop is used by startup scripts before stopping/replacing both roles.
func Stop(ctx context.Context, path string) (result error) {
	started := time.Now()
	operationTrace("stop_begin", "config=%s", path)
	defer func() {
		operationTrace("stop_end", "config=%s elapsed=%s error=%v", path, time.Since(started), result)
	}()
	if err := prepare(path); err != nil {
		return err
	}
	if _, err := requestStop(path); err != nil {
		return err
	}
	guard, err := operationLock(ctx, path)
	if err != nil {
		return err
	}
	defer guard.Close()
	// An explicit Boot that already owned operation.lock may have cleared
	// the first fence while this stop command was waiting. Stop still wins.
	if _, err = requestStop(path); err != nil {
		return err
	}
	return stopAll(ctx, path)
}

func (p *Peer) Status(ctx context.Context) (any, error) {
	s, err := loadSession(p.path)
	if err != nil {
		return nil, err
	}
	phase := "running"
	if !s.Running {
		phase = "stopping"
	}
	b, e := loadRecord(p.path, "B")
	if e != nil || b.Session != p.self.Session {
		phase = "unresponsive"
	} else if v, e := exchange(ctx, p.path, b, "health"); e != nil || !v.Healthy {
		phase = "unresponsive"
	}
	return map[string]any{"managed": true, "phase": phase, "pid": p.self.PID, "guardianPid": b.PID, "restarts": s.RestartsA, "guardianRestarts": s.RestartsB}, nil
}
func (p *Peer) RestartService(ctx context.Context) error {
	r, err := loadRecord(p.path, "B")
	if err != nil {
		return err
	}
	if r.Session != p.self.Session {
		return errors.New("B 会话不匹配")
	}
	_, err = exchange(ctx, p.path, r, "restart-service")
	return err
}
