package server

import (
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

func (s *Server) media(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" && r.Method != "HEAD" {
		http.Error(w, "method", 405)
		return
	}
	path, ok := s.store.MediaPath(r.URL.Query().Get("thread"), r.URL.Query().Get("message"), r.URL.Query().Get("path"))
	if !ok {
		http.NotFound(w, r)
		return
	}
	before, err := os.Lstat(path)
	if err != nil || !before.Mode().IsRegular() {
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
	if err != nil || !info.Mode().IsRegular() || !os.SameFile(before, info) || info.Size() > 256<<20 {
		http.Error(w, "媒体不可用或超过 256 MiB", 415)
		return
	}
	header := make([]byte, 512)
	n, _ := f.Read(header)
	kind := http.DetectContentType(header[:n])
	allowed := map[string]bool{"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true, "image/avif": true, "video/mp4": true, "video/webm": true, "audio/mpeg": true, "audio/wave": true, "audio/ogg": true, "application/ogg": true}
	if !allowed[kind] {
		http.Error(w, "不支持的媒体格式", 415)
		return
	}
	if _, err = f.Seek(0, io.SeekStart); err != nil {
		http.Error(w, "read", 500)
		return
	}
	w.Header().Set("Content-Type", kind)
	w.Header().Set("Content-Disposition", "inline")
	// Never interpret file content as a document if opened in another tab.
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	http.ServeContent(w, r, strings.TrimSpace(filepath.Base(path)), info.ModTime(), f)
}
