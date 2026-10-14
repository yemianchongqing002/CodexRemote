package chat

import (
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
)

var mediaReference = regexp.MustCompile(`!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))`)

// MediaPath authorizes only a file explicitly referenced by a retained message.
// It never exposes a general filesystem browsing endpoint.
func (s *Store) MediaPath(thread, message, reference string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, f := range s.files {
		if f.thread.ID != thread {
			continue
		}
		for _, m := range f.messages {
			if m.ID != message {
				continue
			}
			for _, match := range mediaReference.FindAllStringSubmatch(m.Text, -1) {
				raw := match[1]
				if raw == "" {
					raw = match[2]
				}
				if raw != reference {
					continue
				}
				if strings.ContainsAny(raw, "\x00\r\n") || strings.HasPrefix(strings.ReplaceAll(raw, `\`, "/"), "//") {
					return "", false
				}
				// A native Windows drive path is a filename, not a URL scheme.
				// UNC and device paths are rejected above to keep media local.
				if filepath.IsAbs(raw) && len(filepath.VolumeName(raw)) == 2 {
					return filepath.Clean(raw), true
				}
				u, err := url.Parse(raw)
				if err != nil || u.Scheme != "" || u.Host != "" || u.RawQuery != "" {
					return "", false
				}
				path := u.Path
				if !filepath.IsAbs(path) {
					if f.thread.ProjectPath == "" {
						return "", false
					}
					path = filepath.Join(f.thread.ProjectPath, path)
				}
				return filepath.Clean(path), true
			}
		}
	}
	return "", false
}
