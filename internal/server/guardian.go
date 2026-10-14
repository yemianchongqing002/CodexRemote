package server

import (
	"net/http"
)

func (s *Server) guardianStatus(w http.ResponseWriter, r *http.Request) {
	if !only(w, r, "GET") {
		return
	}
	if s.cfg.GuardianStatus == nil {
		reply(w, 404, map[string]string{"error": "未启用双守护"})
		return
	}
	value, err := s.cfg.GuardianStatus(r.Context())
	if err != nil {
		reply(w, 503, map[string]string{"error": "读取守护状态失败"})
		return
	}
	reply(w, 200, value)
}
func (s *Server) guardianRestart(w http.ResponseWriter, r *http.Request) {
	if !only(w, r, "POST") {
		return
	}
	if s.cfg.RestartService == nil {
		reply(w, 404, map[string]string{"error": "未启用双守护"})
		return
	}
	if err := s.cfg.RestartService(r.Context()); err != nil {
		reply(w, 503, map[string]string{"error": "B 暂未接受重启请求，请稍后检查状态"})
		return
	}
	reply(w, 202, map[string]bool{"accepted": true})
}
