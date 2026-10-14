package desktop

import (
	"context"
	"errors"
	"reflect"
	"testing"
)

func TestPermissionProtocolVersions(t *testing.T) {
	for _, tc := range []struct {
		name    string
		first   map[string]any
		want    []int
		wantErr bool
	}{
		{"v2", map[string]any{"resultType": "success", "result": map[string]any{"applied": true}}, []int{2}, false},
		{"v1 fallback", map[string]any{"resultType": "error", "error": "no-client-found"}, []int{2, 1}, false},
		{"version mismatch", map[string]any{"resultType": "error", "error": "request-version-mismatch"}, []int{2, 1}, false},
		{"not applied", map[string]any{"resultType": "success", "result": map[string]any{"applied": false}}, []int{2}, true},
		{"invalid ack", map[string]any{"resultType": "success", "result": map[string]any{"ok": true}}, []int{2}, true},
		{"timeout", map[string]any{"resultType": "error", "error": "timeout"}, []int{2}, true},
		{"owner failure", map[string]any{"resultType": "error", "error": "no-client-found", "handledByClientId": "desktop-owner"}, []int{2}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			versions := make(chan int, 4)
			c := fakeSocket(t, func(r map[string]any) map[string]any {
				version := int(r["version"].(float64))
				versions <- version
				if version == 2 {
					return tc.first
				}
				return map[string]any{"resultType": "success", "result": map[string]any{"ok": true}}
			})
			w, err := c.connect(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			defer w.conn.Close()
			err = w.updateThreadSettings(map[string]any{"conversationId": liveThread}, "desktop-owner")
			if (err != nil) != tc.wantErr {
				t.Fatal(err)
			}
			if tc.name == "not applied" && !errors.Is(err, ErrStaleControl) {
				t.Fatal(err)
			}
			var got []int
			for len(versions) > 0 {
				got = append(got, <-versions)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatal(got, tc.want)
			}
		})
	}
}
