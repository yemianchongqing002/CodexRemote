package server

import (
	"codexremote/internal/desktop"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"
)

func (s *Server) liveControl(w http.ResponseWriter, r *http.Request) {
	read := r.URL.Path == "/api/thread/live"
	method := "POST"
	if read {
		method = "GET"
	}
	if !only(w, r, method) {
		return
	}
	if s.cfg.LiveControl == nil || s.cfg.Delivery == nil {
		reply(w, 403, map[string]string{"error": "远程审批与权限设置未启用"})
		return
	}
	var b struct {
		ThreadID string `json:"threadId"`
		Key      string `json:"key"`
		Decision string `json:"decision"`
		Version  string `json:"version"`
		desktop.PermissionSettings
	}
	if read {
		b.ThreadID = r.URL.Query().Get("threadId")
	} else {
		d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
		d.DisallowUnknownFields()
		if d.Decode(&b) != nil || d.Decode(new(any)) != io.EOF {
			reply(w, 400, map[string]string{"error": "请求格式无效"})
			return
		}
		if r.URL.Path == "/api/thread/approval" && (len(b.Key) != 64 || (b.Decision != "accept" && b.Decision != "decline" && b.Decision != "cancel")) || r.URL.Path == "/api/thread/permissions" && (len(b.Version) != 64 || !b.PermissionSettings.Valid()) {
			reply(w, 400, map[string]string{"error": "审批或权限设置无效"})
			return
		}
	}
	s.store.RefreshThread(b.ThreadID)
	p, ok := s.store.Read(b.ThreadID, "", "", 1)
	if !ok || p.Thread.Archived {
		reply(w, 404, map[string]string{"error": "聊天不存在或已归档"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 16*time.Second)
	defer cancel()
	var result desktop.LiveState
	var err error
	switch r.URL.Path {
	case "/api/thread/live":
		result, err = s.cfg.LiveControl.Live(ctx, b.ThreadID)
	case "/api/thread/approval":
		result, err = s.cfg.LiveControl.Approve(ctx, b.ThreadID, b.Key, b.Decision)
	case "/api/thread/permissions":
		result, err = s.cfg.LiveControl.SetPermissions(ctx, b.ThreadID, b.Version, b.PermissionSettings)
	}
	if err != nil {
		status := 502
		if errors.Is(err, desktop.ErrStaleControl) {
			status = 409
		}
		reply(w, status, map[string]string{"error": err.Error()})
		return
	}
	reply(w, 200, result)
}
