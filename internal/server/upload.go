package server

import (
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"codexremote/internal/delivery"
)

func (s *Server) uploadImage(w http.ResponseWriter, r *http.Request) {
	if s.cfg.Delivery == nil {
		reply(w, 403, map[string]string{"error": "此电脑未启用网页发送"})
		return
	}
	switch r.Method {
	case "POST":
		// Mobile uploads may exceed the normal short JSON request deadlines.
		controller := http.NewResponseController(w)
		_ = controller.SetReadDeadline(time.Now().Add(90 * time.Second))
		_ = controller.SetWriteDeadline(time.Now().Add(95 * time.Second))
		data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, delivery.MaxImageBytes))
		if err != nil {
			reply(w, 413, map[string]string{"error": "图片上传未完成或超过 8 MiB"})
			return
		}
		id, err := s.cfg.Delivery.SaveImage(data)
		if err != nil {
			reply(w, 400, map[string]string{"error": err.Error()})
			return
		}
		reply(w, 201, map[string]string{"id": id})
	case "GET", "HEAD":
		if strings.Contains(r.URL.Query().Get("id"), ".file.") {
			http.NotFound(w, r)
			return
		}
		path, err := s.cfg.Delivery.ImagePath(r.URL.Query().Get("id"))
		if err != nil {
			http.NotFound(w, r)
			return
		}
		f, err := os.Open(path)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer f.Close()
		info, err := f.Stat()
		if err != nil {
			http.NotFound(w, r)
			return
		}
		kind := map[string]string{".png": "image/png", ".jpeg": "image/jpeg", ".gif": "image/gif"}[filepath.Ext(path)]
		w.Header().Set("Content-Type", kind)
		w.Header().Set("Content-Disposition", "inline")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
		http.ServeContent(w, r, filepath.Base(path), info.ModTime(), f)
	default:
		http.Error(w, "method", 405)
	}
}

func (s *Server) uploadFile(w http.ResponseWriter, r *http.Request) {
	if s.cfg.Delivery == nil {
		reply(w, 403, map[string]string{"error": "此电脑未启用网页发送"})
		return
	}
	if r.Method != "POST" {
		http.Error(w, "method", 405)
		return
	}
	controller := http.NewResponseController(w)
	_ = controller.SetReadDeadline(time.Now().Add(90 * time.Second))
	_ = controller.SetWriteDeadline(time.Now().Add(95 * time.Second))
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, delivery.MaxImageBytes))
	if err != nil {
		reply(w, 413, map[string]string{"error": "文件上传未完成或超过 8 MiB"})
		return
	}
	id, err := s.cfg.Delivery.SaveFile(r.URL.Query().Get("name"), data)
	if err != nil {
		reply(w, 400, map[string]string{"error": err.Error()})
		return
	}
	reply(w, 201, map[string]string{"id": id})
}
