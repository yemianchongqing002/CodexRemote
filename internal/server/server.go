package server

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"codexremote/internal/chat"
	"codexremote/internal/delivery"
	"codexremote/internal/desktop"
	"codexremote/internal/platform"
)

//go:embed web/*
var assets embed.FS

type Config struct {
	PrivacyFile string
	LiveControl interface {
		Live(context.Context, string) (desktop.LiveState, error)
		Approve(context.Context, string, string, string) (desktop.LiveState, error)
		SetPermissions(context.Context, string, string, desktop.PermissionSettings) (desktop.LiveState, error)
	}
	Models         *desktop.Catalog
	Interrupt      func(context.Context, string, string) error
	GuardianHealth http.HandlerFunc
	GuardianStatus func(context.Context) (any, error)
	RestartService func(context.Context) error
	Managed        bool
	Token          string
	NoAuth         bool
	AllowedHosts   []string
	AutoLocalHosts bool
	Interval       time.Duration
	Delivery       *delivery.Service
	Creator        delivery.Creator
}
type Server struct {
	store       *chat.Store
	cfg         Config
	handler     http.Handler
	clients     atomic.Int32
	refreshMu   sync.Mutex
	lastRefresh time.Time
	loginMu     sync.Mutex
	attempts    int
	loginWindow time.Time
}

func New(store *chat.Store, cfg Config) *Server {
	if cfg.Interval < time.Second {
		cfg.Interval = 3 * time.Second
	}
	s := &Server{store: store, cfg: cfg}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/login", s.login)
	mux.HandleFunc("/api/logout", s.authorize(s.logout))
	mux.HandleFunc("/api/version", s.release)
	mux.HandleFunc("/api/status", s.authorize(s.status))
	mux.HandleFunc("/api/models", s.authorize(s.models))
	mux.HandleFunc("/api/thread/live", s.authorize(s.liveControl))
	mux.HandleFunc("/api/thread/approval", s.authorize(s.liveControl))
	mux.HandleFunc("/api/thread/permissions", s.authorize(s.liveControl))
	mux.HandleFunc("/api/thread/interrupt", s.authorize(s.interrupt))
	mux.HandleFunc("/api/guardian/status", s.authorize(s.guardianStatus))
	mux.HandleFunc("/api/guardian/restart", s.authorize(s.guardianRestart))
	if cfg.GuardianHealth != nil {
		mux.HandleFunc("/internal/guardian/health", cfg.GuardianHealth)
	}
	mux.HandleFunc("/api/threads", s.authorize(s.threads))
	mux.HandleFunc("/api/media", s.authorize(s.media))
	mux.HandleFunc("/api/thread", s.authorize(s.thread))
	mux.HandleFunc("/api/events", s.authorize(s.events))
	mux.HandleFunc("/api/privacy", s.authorize(s.privacyDisclosure))
	mux.HandleFunc("/api/send", s.authorize(s.send))
	mux.HandleFunc("/api/upload-image", s.authorize(s.uploadImage))
	mux.HandleFunc("/api/upload-file", s.authorize(s.uploadFile))
	mux.HandleFunc("/api/send-status", s.authorize(s.sendStatus))
	mux.HandleFunc("/api/thread/create", s.authorize(s.createThread))
	mux.HandleFunc("/api/queue", s.authorize(s.queueList))
	mux.HandleFunc("/api/queue/cancel", s.authorize(s.queueCancel))
	mux.HandleFunc("/api/queue/steer", s.authorize(s.queueSteer))
	root, _ := fs.Sub(assets, "web")
	static := http.FileServer(http.FS(root))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" && r.Method != "HEAD" {
			http.Error(w, "method", 405)
			return
		}
		switch r.URL.Path {
		case "/", "/app.js", "/models.js", "/live.js", "/runtime.js", "/connections.js", "/deploy.js", "/rich.js", "/style.css", "/icon.svg":
			static.ServeHTTP(w, r)
		default:
			if strings.HasPrefix(r.URL.Path, "/vendor/") {
				w.Header().Set("Cache-Control", "private, max-age=86400")
				static.ServeHTTP(w, r)
				return
			}
			http.NotFound(w, r)
		}
	})
	s.handler = s.boundary(mux)
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.handler.ServeHTTP(w, r) }
func (s *Server) Run(ctx context.Context) {
	t := time.NewTicker(s.cfg.Interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if s.clients.Load() > 0 {
				s.refresh()
			}
		}
	}
}
func (s *Server) refresh() {
	s.refreshMu.Lock()
	defer s.refreshMu.Unlock()
	if time.Since(s.lastRefresh) >= s.cfg.Interval {
		s.store.Refresh(false)
		s.lastRefresh = time.Now()
	}
}

func (s *Server) boundary(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/events" {
			_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(20 * time.Second))
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: http: data:; media-src 'self' https: http:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		host := r.Host
		if h, _, e := net.SplitHostPort(host); e == nil {
			host = h
		}
		host = strings.ToLower(host)
		allowed := false
		for _, h := range s.cfg.AllowedHosts {
			if strings.ToLower(h) == host {
				allowed = true
			}
		}
		if !allowed && s.cfg.AutoLocalHosts {
			ip := net.ParseIP(strings.Trim(host, "[]"))
			if ip != nil {
				// The embedded listener supplies an authenticated local address.
				if local, ok := r.Context().Value(http.LocalAddrContextKey).(net.Addr); ok {
					addr, _, _ := net.SplitHostPort(local.String())
					allowed = ip.Equal(net.ParseIP(addr))
					if aliases, ok := local.(interface{ AllowsIP(net.IP) bool }); ok {
						allowed = aliases.AllowsIP(ip)
					}
				}
				if !allowed {
					addresses, _ := net.InterfaceAddrs()
					for _, addr := range addresses {
						if local, ok := addr.(*net.IPNet); ok && ip.Equal(local.IP) {
							allowed = true
							break
						}
					}
				}
			}
		}
		if !allowed {
			http.Error(w, "Host 未获允许；请在启动时配置 --allow-host", 403)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/") {
			if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
				http.Error(w, "cross-site", 403)
				return
			}
			if origin := r.Header.Get("Origin"); origin != "" {
				u, e := url.Parse(origin)
				scheme := "http"
				if s.secure(r) {
					scheme = "https"
				}
				if e != nil || u.Host != r.Host || u.Scheme != scheme {
					http.Error(w, "origin", 403)
					return
				}
			}
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) secure(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	h, _, _ := net.SplitHostPort(r.RemoteAddr)
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback() && r.Header.Get("X-Forwarded-Proto") == "https"
}
func reply(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func only(w http.ResponseWriter, r *http.Request, method string) bool {
	if r.Method != method {
		http.Error(w, "method", 405)
		return false
	}
	return true
}
func (s *Server) signature(v string) string {
	h := hmac.New(sha256.New, []byte(s.cfg.Token))
	h.Write([]byte(v))
	return hex.EncodeToString(h.Sum(nil))
}
func (s *Server) valid(r *http.Request) bool {
	if s.cfg.NoAuth {
		return true
	}
	c, e := r.Cookie("cr_session")
	if e != nil {
		return false
	}
	p := strings.Split(c.Value, ".")
	if len(p) != 3 {
		return false
	}
	exp, e := strconv.ParseInt(p[0], 10, 64)
	return e == nil && time.Now().Unix() < exp && hmac.Equal([]byte(p[2]), []byte(s.signature(p[0]+"."+p[1])))
}
func (s *Server) authorize(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.valid(r) {
			reply(w, 401, map[string]string{"error": "请先输入访问口令"})
			return
		}
		if r.Method != "GET" && r.Method != "HEAD" && !s.checkPrivacyRevision(w, r) {
			return
		}
		next(w, r)
	}
}
func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	if !only(w, r, "POST") {
		return
	}
	if s.cfg.NoAuth {
		reply(w, 200, map[string]bool{"ok": true})
		return
	}
	s.loginMu.Lock()
	if time.Since(s.loginWindow) > time.Minute {
		s.attempts = 0
		s.loginWindow = time.Now()
	}
	s.attempts++
	over := s.attempts > 20
	s.loginMu.Unlock()
	if over {
		reply(w, 429, map[string]string{"error": "尝试过于频繁，请一分钟后重试"})
		return
	}
	var body struct {
		Token string `json:"token"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 2048)).Decode(&body) != nil {
		http.Error(w, "body", 400)
		return
	}
	a, b := sha256.Sum256([]byte(body.Token)), sha256.Sum256([]byte(s.cfg.Token))
	if subtle.ConstantTimeCompare(a[:], b[:]) != 1 {
		reply(w, 401, map[string]string{"error": "访问口令不正确"})
		return
	}
	var random [12]byte
	if _, e := rand.Read(random[:]); e != nil {
		http.Error(w, "entropy", 500)
		return
	}
	expires := time.Now().Add(7 * 24 * time.Hour)
	v := strconv.FormatInt(expires.Unix(), 10) + "." + hex.EncodeToString(random[:])
	http.SetCookie(w, &http.Cookie{Name: "cr_session", Value: v + "." + s.signature(v), Path: "/", HttpOnly: true, Secure: s.secure(r), SameSite: http.SameSiteStrictMode, Expires: expires, MaxAge: 7 * 86400})
	reply(w, 200, map[string]bool{"ok": true})
}
func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	if !only(w, r, "POST") {
		return
	}
	http.SetCookie(w, &http.Cookie{Name: "cr_session", Value: "", Path: "/", MaxAge: -1, HttpOnly: true, Secure: s.secure(r), SameSite: http.SameSiteStrictMode})
	reply(w, 200, map[string]bool{"ok": true})
}
func (s *Server) status(w http.ResponseWriter, r *http.Request) {
	if !only(w, r, "GET") {
		return
	}
	name := platform.ComputerName()
	reply(w, 200, map[string]any{"connectionName": name, "hostName": name, "adapter": "desktop-rollout", "sync": "persisted-messages", "release": releaseInfo(), "version": s.store.Version(), "warning": s.store.Warning(), "sendingEnabled": s.cfg.Delivery != nil, "managed": s.cfg.Managed, "authRequired": !s.cfg.NoAuth})
}

func (s *Server) send(w http.ResponseWriter, r *http.Request) {
	if !only(w, r, "POST") {
		return
	}
	if s.cfg.Delivery == nil {
		reply(w, 403, map[string]string{"error": "此电脑未启用网页发送"})
		return
	}
	var body struct {
		ID            string                 `json:"id"`
		ThreadID      string                 `json:"threadId"`
		Text          string                 `json:"text"`
		Mode          string                 `json:"mode"`
		Images        []string               `json:"images"`
		ModelSettings *desktop.ModelSettings `json:"modelSettings,omitempty"`
	}
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 24<<10))
	d.DisallowUnknownFields()
	if d.Decode(&body) != nil {
		reply(w, 400, map[string]string{"error": "消息格式不正确或正文过长"})
		return
	}
	s.refresh()
	page, ok := s.store.Read(body.ThreadID, "", "", 1)
	if !ok {
		reply(w, 404, map[string]string{"error": "目标聊天不存在"})
		return
	}
	if page.Thread.Archived {
		reply(w, 409, map[string]string{"error": "请先在桌面取消归档，再发送消息"})
		return
	}
	if body.ModelSettings != nil {
		if s.cfg.Models == nil {
			reply(w, 403, map[string]string{"error": "模型设置未启用"})
			return
		}
		models, err := s.cfg.Models.List(r.Context())
		if err != nil {
			reply(w, 503, map[string]string{"error": err.Error()})
			return
		}
		if err = desktop.ValidateModelSettings(models, *body.ModelSettings); err != nil {
			reply(w, 400, map[string]string{"error": err.Error()})
			return
		}
	}
	e, err := s.cfg.Delivery.SubmitWithSettings(body.ID, body.ThreadID, body.Text, body.Images, body.ModelSettings, body.Mode)
	if err != nil {
		reply(w, 409, map[string]string{"error": err.Error()})
		return
	}
	status := 200
	if e.Status == "pending" || e.Status == "queued" {
		status = 202
	}
	reply(w, status, e)
}
func (s *Server) sendStatus(w http.ResponseWriter, r *http.Request) {
	if !only(w, r, "GET") {
		return
	}
	if s.cfg.Delivery == nil {
		reply(w, 403, map[string]string{"error": "此电脑未启用网页发送"})
		return
	}
	e, ok := s.cfg.Delivery.Get(r.URL.Query().Get("id"))
	if !ok {
		reply(w, 404, map[string]string{"error": "没有找到发送记录，请先核对聊天，不要自动重发"})
		return
	}
	if e.Status == "created" || e.Status == "created_unconfirmed" {
		s.store.Refresh(true)
	}
	reply(w, 200, e)
}
func (s *Server) threads(w http.ResponseWriter, r *http.Request) {
	if !only(w, r, "GET") {
		return
	}
	s.refresh()
	reply(w, 200, s.store.Sidebar())
}
func (s *Server) thread(w http.ResponseWriter, r *http.Request) {
	if !only(w, r, "GET") {
		return
	}
	s.refresh()
	q := r.URL.Query()
	id := q.Get("id")
	if len(id) > 160 || strings.ContainsAny(id, "/\\") {
		http.Error(w, "invalid id", 400)
		return
	}
	if q.Get("before") != "" && q.Get("after") != "" {
		http.Error(w, "one cursor only", 400)
		return
	}
	limit, _ := strconv.Atoi(q.Get("limit"))
	page, ok := s.store.Read(id, q.Get("before"), q.Get("after"), limit)
	if !ok {
		http.NotFound(w, r)
		return
	}
	reply(w, 200, page)
}
func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	if !only(w, r, "GET") {
		return
	}
	if s.clients.Add(1) > 8 {
		s.clients.Add(-1)
		http.Error(w, "too many viewers", 429)
		return
	}
	defer s.clients.Add(-1)
	if _, ok := w.(http.Flusher); !ok {
		http.Error(w, "stream unavailable", 500)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("X-Accel-Buffering", "no")
	controller := http.NewResponseController(w)
	write := func(data string) bool {
		_ = controller.SetWriteDeadline(time.Now().Add(5 * time.Second))
		_, e := fmt.Fprint(w, data)
		if e != nil {
			return false
		}
		return controller.Flush() == nil
	}
	s.refresh()
	var changes <-chan struct{}
	if s.cfg.Delivery != nil {
		changes = s.cfg.Delivery.Changes()
	}
	v := s.eventVersion()
	if !write("retry: 5000\nevent: change\ndata: " + v + "\n\n") {
		return
	}
	t := time.NewTicker(s.cfg.Interval)
	defer t.Stop()
	lastSent := time.Now()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-changes:
			changes = s.cfg.Delivery.Changes()
			if !s.valid(r) {
				write("event: expired\ndata: {}\n\n")
				return
			}
			next := s.eventVersion()
			if next != v {
				v = next
				if !write("event: change\ndata: " + v + "\n\n") {
					return
				}
				lastSent = time.Now()
			}
		case <-t.C:
			if !s.valid(r) {
				write("event: expired\ndata: {}\n\n")
				return
			}
			next := s.eventVersion()
			if next != v {
				v = next
				if !write("event: change\ndata: " + v + "\n\n") {
					return
				}
				lastSent = time.Now()
			} else if time.Since(lastSent) >= 30*time.Second {
				if !write(": heartbeat\n\n") {
					return
				}
				lastSent = time.Now()
			}
		}
	}
}

func (s *Server) queueList(w http.ResponseWriter, r *http.Request) {
	if !only(w, r, "GET") {
		return
	}
	if s.cfg.Delivery == nil {
		reply(w, 403, map[string]string{"error": "发送未启用"})
		return
	}
	reply(w, 200, map[string]any{"entries": s.cfg.Delivery.QueueStatus(r.URL.Query().Get("threadId"))})
}
func (s *Server) queueCancel(w http.ResponseWriter, r *http.Request) {
	if !only(w, r, "POST") {
		return
	}
	if s.cfg.Delivery == nil {
		reply(w, 403, map[string]string{"error": "发送未启用"})
		return
	}
	var body struct {
		ID string `json:"id"`
	}
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
	d.DisallowUnknownFields()
	if d.Decode(&body) != nil {
		reply(w, 400, map[string]string{"error": "请求格式不正确"})
		return
	}
	entry, err := s.cfg.Delivery.Cancel(body.ID)
	if err != nil {
		reply(w, 409, map[string]string{"error": err.Error()})
		return
	}
	reply(w, 200, entry)
}

func (s *Server) createThread(w http.ResponseWriter, r *http.Request) {
	if !only(w, r, "POST") {
		return
	}
	if s.cfg.Delivery == nil || s.cfg.Creator == nil {
		reply(w, 403, map[string]string{"error": "未启用新建会话"})
		return
	}
	var body struct {
		ID          string `json:"id"`
		ProjectPath string `json:"projectPath"`
		Text        string `json:"text"`
	}
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 24<<10))
	d.DisallowUnknownFields()
	if d.Decode(&body) != nil {
		reply(w, 400, map[string]string{"error": "请求格式不正确"})
		return
	}
	s.refresh()
	allowed := false
	for _, project := range s.store.Sidebar().Projects {
		for _, root := range project.Roots {
			if root != "" && root == body.ProjectPath {
				allowed = true
				break
			}
		}
	}
	info, err := os.Stat(body.ProjectPath)
	if !allowed || !filepath.IsAbs(body.ProjectPath) || err != nil || !info.IsDir() {
		reply(w, 403, map[string]string{"error": "只能在列表中已存在且可用的本机项目目录创建会话"})
		return
	}
	entry, err := s.cfg.Delivery.Create(body.ID, body.ProjectPath, body.Text, s.cfg.Creator)
	if err != nil {
		reply(w, 409, map[string]string{"error": err.Error()})
		return
	}
	code := 200
	if entry.Status == "pending" {
		code = 202
	}
	reply(w, code, entry)
}

func (s *Server) eventVersion() string {
	v := s.store.Version()
	if s.cfg.Delivery != nil {
		v += fmt.Sprintf(":%d", s.cfg.Delivery.Revision())
	}
	return v
}

func (s *Server) queueSteer(w http.ResponseWriter, r *http.Request) {
	if !only(w, r, "POST") {
		return
	}
	if s.cfg.Delivery == nil {
		reply(w, 403, map[string]string{"error": "发送未启用"})
		return
	}
	var body struct {
		ID string `json:"id"`
	}
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
	d.DisallowUnknownFields()
	if d.Decode(&body) != nil {
		reply(w, 400, map[string]string{"error": "请求格式不正确"})
		return
	}
	entry, ok := s.cfg.Delivery.Get(body.ID)
	if !ok {
		reply(w, 404, map[string]string{"error": "找不到排队消息"})
		return
	}
	s.refresh()
	page, ok := s.store.Read(entry.ThreadID, "", "", 1)
	if !ok || page.Thread.Archived {
		reply(w, 409, map[string]string{"error": "聊天不可用或已归档"})
		return
	}
	entry, err := s.cfg.Delivery.Promote(body.ID)
	if err != nil {
		reply(w, 409, map[string]string{"error": err.Error()})
		return
	}
	status := 200
	if entry.Status == "pending" {
		status = 202
	}
	reply(w, status, entry)
}
