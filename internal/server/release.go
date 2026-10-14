package server

import "net/http"

// Software versions are independent of the chat store's change marker.
const ServerVersion = "1.0.0"

func releaseInfo() map[string]any {
	return map[string]any{
		"serverVersion":      ServerVersion,
		"clientMin":          "1.0.0",
		"clientMaxExclusive": "1.1.0",
	}
}

// Public metadata permits compatibility checks before token authentication.
// The regular Host/Origin boundary still applies; no machine or chat data is exposed.
func (s *Server) release(w http.ResponseWriter, r *http.Request) {
	if !only(w, r, "GET") {
		return
	}
	reply(w, 200, map[string]any{"adapter": "desktop-rollout", "release": releaseInfo()})
}
