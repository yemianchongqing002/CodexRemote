package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"time"
)

func (s *Server) models(w http.ResponseWriter, r *http.Request) {
	if !only(w, r, "GET") {
		return
	}
	if s.cfg.Models == nil || s.cfg.Delivery == nil {
		reply(w, 403, map[string]string{"error": "模型设置未启用"})
		return
	}
	models, err := s.cfg.Models.List(r.Context())
	if err != nil {
		reply(w, 503, map[string]string{"error": err.Error()})
		return
	}
	reply(w, 200, map[string]any{"models": models, "source": "目标电脑 Codex", "cacheSeconds": 300})
}

func (s *Server) interrupt(w http.ResponseWriter, r *http.Request) {
	if !only(w, r, "POST") {
		return
	}
	if s.cfg.Interrupt == nil || s.cfg.Delivery == nil {
		reply(w, 403, map[string]string{"error": "停止功能未启用"})
		return
	}
	var body struct {
		ThreadID string `json:"threadId"`
		TurnID   string `json:"turnId"`
	}
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	d.DisallowUnknownFields()
	if d.Decode(&body) != nil || d.Decode(new(any)) != io.EOF || body.TurnID == "" || len(body.TurnID) > 160 {
		reply(w, 400, map[string]string{"error": "缺少当前轮标识，请刷新聊天"})
		return
	}
	s.refresh()
	page, ok := s.store.Read(body.ThreadID, "", "", 1)
	if !ok || page.Thread.Archived {
		reply(w, 404, map[string]string{"error": "聊天不存在或已归档"})
		return
	}
	if page.Thread.Status != "active" || page.Thread.ActiveTurnID != body.TurnID {
		reply(w, 409, map[string]string{"error": "当前轮已经变化，请刷新后确认"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 18*time.Second)
	defer cancel()
	if err := s.cfg.Interrupt(ctx, body.ThreadID, body.TurnID); err != nil {
		reply(w, 502, map[string]string{"error": err.Error()})
		return
	}
	reply(w, 200, map[string]any{"stopped": true})
}
