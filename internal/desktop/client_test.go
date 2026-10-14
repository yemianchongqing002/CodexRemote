package desktop

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"sync/atomic"
	"testing"
	"time"
)

func fakeSocket(t *testing.T, behavior func(map[string]any) map[string]any, discovery ...func(map[string]any) map[string]any) *Client {
	t.Helper()
	path, listener, e := testListener(t)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { listener.Close() })
	go func() {
		conn, e := listener.Accept()
		if e != nil {
			return
		}
		defer conn.Close()
		conn.SetDeadline(time.Now().Add(3 * time.Second))
		for {
			var header [4]byte
			if _, e = io.ReadFull(conn, header[:]); e != nil {
				return
			}
			size := binary.LittleEndian.Uint32(header[:])
			if size > 1<<20 {
				return
			}
			b := make([]byte, size)
			if _, e = io.ReadFull(conn, b); e != nil {
				return
			}
			var request map[string]any
			if json.Unmarshal(b, &request) != nil {
				return
			}
			method, _ := request["method"].(string)
			var response map[string]any
			switch method {
			case "initialize":
				response = map[string]any{"resultType": "success", "result": map[string]string{"clientId": "viewer"}}
			case "thread-owner-discovery":
				response = map[string]any{"resultType": "success", "handledByClientId": "desktop-owner", "result": map[string]any{}}
				if len(discovery) > 0 {
					response = discovery[0](request)
				}
			default:
				response = behavior(request)
			}
			if response == nil {
				return
			}
			if response["type"] != "broadcast" {
				response["type"] = "response"
				response["requestId"] = request["requestId"]
				response["method"] = method
			}
			if method != "thread-owner-discovery" && !(response["resultType"] == "error" && response["handledByClientId"] == nil) {
				response["handledByClientId"] = "desktop-owner"
			}
			out, _ := json.Marshal(response)
			frame := make([]byte, 4+len(out))
			binary.LittleEndian.PutUint32(frame, uint32(len(out)))
			copy(frame[4:], out)
			// Fragment the frame to exercise exact reads.
			conn.Write(frame[:2])
			conn.Write(frame[2:])
		}
	}()
	return &Client{Socket: path}
}
func TestSendActiveAndOwnerPin(t *testing.T) {
	called := make(chan map[string]any, 1)
	c := fakeSocket(t, func(r map[string]any) map[string]any {
		called <- r
		return map[string]any{"resultType": "success", "result": map[string]any{"result": map[string]string{"turnId": "turn1"}}}
	})
	result := c.Send(context.Background(), "thread", "request-id", "hello")
	if result.Status != "accepted" || result.TurnID != "turn1" {
		t.Fatal(result)
	}
	r := <-called
	if r["method"] != "thread-follower-steer-turn" || r["version"] != float64(1) || r["targetClientId"] != "desktop-owner" {
		t.Fatal(r)
	}
	params := r["params"].(map[string]any)
	if params["conversationId"] != "thread" || params["clientUserMessageId"] != "request-id" {
		t.Fatal(params)
	}
}

func TestImageInputForStartAndSteer(t *testing.T) {
	for _, queued := range []bool{false, true} {
		name := "steer"
		if queued {
			name = "start"
		}
		t.Run(name, func(t *testing.T) {
			called := make(chan map[string]any, 1)
			c := fakeSocket(t, func(r map[string]any) map[string]any {
				called <- r
				return map[string]any{"resultType": "success", "result": map[string]any{"result": map[string]string{"turnId": "image-turn"}}}
			})
			var result Result
			if queued {
				result = c.StartImages(context.Background(), "thread", "image-request", "", []string{"/private/upload.png"})
			} else {
				result = c.SendImages(context.Background(), "thread", "image-request", "", []string{"/private/upload.png"})
			}
			if result.Status != "accepted" {
				t.Fatal(result)
			}
			r := <-called
			params := r["params"].(map[string]any)
			if queued {
				params = params["turnStart"].(map[string]any)["request"].(map[string]any)
			}
			input := params["input"].([]any)
			if len(input) != 1 {
				t.Fatal(input)
			}
			img := input[0].(map[string]any)
			if img["type"] != "localImage" || img["path"] != "/private/upload.png" {
				t.Fatal(img)
			}
		})
	}
}
func TestIdleFallbackOnlyAfterExplicitRejection(t *testing.T) {
	calls := make(chan string, 2)
	c := fakeSocket(t, func(r map[string]any) map[string]any {
		m := r["method"].(string)
		calls <- m
		if m == "thread-follower-steer-turn" {
			return map[string]any{"resultType": "error", "error": "Cannot steer conversation thread because its active turn already ended"}
		}
		if r["version"] != float64(2) {
			return nil
		}
		return map[string]any{"resultType": "success", "result": map[string]any{"result": map[string]any{"turn": map[string]string{"id": "turn2"}}}}
	})
	result := c.Send(context.Background(), "thread", "request-id", "hello")
	if result.Status != "accepted" || result.TurnID != "turn2" {
		t.Fatal(result)
	}
	if <-calls != "thread-follower-steer-turn" || <-calls != "thread-follower-start-turn" {
		t.Fatal("wrong fallback")
	}
}
func TestUncertainReceiptDoesNotFallback(t *testing.T) {
	for _, kind := range []string{"disconnect", "timeout", "reject", "invalid-result"} {
		t.Run(kind, func(t *testing.T) {
			var calls atomic.Int32
			c := fakeSocket(t, func(r map[string]any) map[string]any {
				calls.Add(1)
				switch kind {
				case "disconnect":
					return nil
				case "timeout":
					return map[string]any{"resultType": "error", "error": "request-timeout"}
				case "reject":
					return map[string]any{"resultType": "error", "error": "permission denied"}
				default:
					return map[string]any{"resultType": "success", "result": map[string]any{}}
				}
			})
			r := c.Send(context.Background(), "thread", "request-id", "hello")
			want := "unknown"
			if kind == "reject" {
				want = "failed"
			}
			if r.Status != want || r.Retryable || calls.Load() != 1 {
				t.Fatalf("%+v calls=%d", r, calls.Load())
			}
		})
	}
}
func TestUnavailableAndProbe(t *testing.T) {
	c := &Client{Socket: "/nonexistent/codexremote-test.sock"}
	if r := c.Send(context.Background(), "t", "id", "hi"); r.Status != "failed" || !r.Retryable {
		t.Fatal(r)
	}
	c = fakeSocket(t, func(map[string]any) map[string]any { t.Error("probe must not send"); return nil })
	if e := c.Probe(context.Background(), "thread"); e != nil {
		t.Fatal(e)
	}
}

func TestQueueStartNeverSteers(t *testing.T) {
	var calls atomic.Int32
	c := fakeSocket(t, func(r map[string]any) map[string]any {
		calls.Add(1)
		if r["method"] != "thread-follower-start-turn" {
			t.Error("queued input must not steer")
		}
		return map[string]any{"resultType": "error", "error": "active turn"}
	})
	result := c.Start(context.Background(), "thread", "id", "queued text")
	if result.Status != "failed" || calls.Load() != 1 {
		t.Fatal(result)
	}
}

func TestQueueRechecksBeforeStart(t *testing.T) {
	c := fakeSocket(t, func(map[string]any) map[string]any { t.Error("must not send after thread became busy"); return nil })
	c.BeforeQueuedStart = func(string) bool { return false }
	if result := c.Start(context.Background(), "thread", "id", "later"); result.Status != "deferred" {
		t.Fatal(result)
	}
}

func TestSendOpensExactThreadAndConfirmsOwner(t *testing.T) {
	const thread = "11111111-2222-3333-4444-555555555555"
	for _, recovered := range []bool{true, false} {
		t.Run(fmt.Sprint(recovered), func(t *testing.T) {
			var opened, submissions atomic.Int32
			c := fakeSocket(t, func(r map[string]any) map[string]any {
				submissions.Add(1)
				if r["targetClientId"] != "recovered-owner" {
					t.Error("input must target the newly confirmed owner")
				}
				return map[string]any{"resultType": "success", "result": map[string]any{"result": map[string]string{"turnId": "turn"}}}
			}, func(r map[string]any) map[string]any {
				if r["params"].(map[string]any)["conversationId"] != thread {
					t.Error("discovery changed target thread")
				}
				if recovered && opened.Load() == 1 {
					return map[string]any{"resultType": "success", "handledByClientId": "recovered-owner"}
				}
				return map[string]any{"resultType": "error", "error": "no owner"}
			})
			c.OpenThread = func(_ context.Context, id string) error {
				if id != thread {
					t.Error("opened wrong thread")
				}
				opened.Add(1)
				return nil
			}
			result := c.Send(context.Background(), thread, "request-id", "hello")
			if opened.Load() != 1 {
				t.Fatal("must request open exactly once")
			}
			if recovered {
				if result.Status != "accepted" || submissions.Load() != 1 {
					t.Fatal(result, submissions.Load())
				}
			} else if result.Status != "failed" || submissions.Load() != 0 {
				t.Fatal(result, submissions.Load())
			}
		})
	}
}
