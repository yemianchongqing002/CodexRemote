package delivery

import (
	"context"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"codexremote/internal/desktop"
)

func TestRetryDeliveryOutcomes(t *testing.T) {
	for _, tc := range []struct {
		name    string
		results []desktop.Result
		want    string
		calls   int
	}{
		{"recovers", []desktop.Result{{Status: "failed", Retryable: true}, {Status: "accepted", TurnID: "turn"}}, "accepted", 2},
		{"exhausted", []desktop.Result{{Status: "failed", Retryable: true, Detail: "desktop unavailable"}}, "failed", 3},
		{"uncertain", []desktop.Result{{Status: "unknown", Retryable: true}}, "unknown", 1},
		{"permanent", []desktop.Result{{Status: "failed", Detail: "permission denied"}}, "failed", 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			sender := senderFunc(func(_ context.Context, thread, id, text string) desktop.Result {
				if thread != "thread" || id != "retry-request-0001" || text != "private body" {
					t.Errorf("retry changed input: %s %s %s", thread, id, text)
				}
				n := int(calls.Add(1)) - 1
				if n >= len(tc.results) {
					n = len(tc.results) - 1
				}
				return tc.results[n]
			})
			s, err := Open(filepath.Join(t.TempDir(), "outbox"), sender)
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			if s.retryDelay != 30*time.Second {
				t.Fatal("wrong production interval", s.retryDelay)
			}
			s.retryDelay = 5 * time.Millisecond
			if _, err = s.Submit("retry-request-0001", "thread", "private body"); err != nil {
				t.Fatal(err)
			}
			e := waitEntry(t, s, "retry-request-0001")
			if e.Status != tc.want || int(calls.Load()) != tc.calls || e.Attempts != tc.calls || !e.NextRetryAt.IsZero() {
				t.Fatal(e, calls.Load())
			}
			if tc.name == "exhausted" && !strings.Contains(e.Detail, "3 次") {
				t.Fatal(e.Detail)
			}
			s.Submit("retry-request-0001", "thread", "private body")
			if int(calls.Load()) != tc.calls {
				t.Fatal("duplicate submit bypassed receipt")
			}
		})
	}
}
func TestRetryWaitIsPendingAndCloseStopsFurtherAttempts(t *testing.T) {
	var calls atomic.Int32
	s, err := Open(filepath.Join(t.TempDir(), "outbox"), senderFunc(func(context.Context, string, string, string) desktop.Result {
		calls.Add(1)
		return desktop.Result{Status: "failed", Retryable: true}
	}))
	if err != nil {
		t.Fatal(err)
	}
	s.Submit("retry-request-0002", "thread", "body")
	deadline := time.Now().Add(time.Second)
	for {
		e, _ := s.Get("retry-request-0002")
		if !e.NextRetryAt.IsZero() {
			if e.Status != "pending" || !strings.Contains(e.Detail, "30 秒") || time.Until(e.NextRetryAt) < 29*time.Second {
				t.Fatal(e)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("retry not scheduled")
		}
		time.Sleep(time.Millisecond)
	}
	if _, err := s.Submit("retry-request-0003", "thread", "another"); err != ErrBusy {
		t.Fatal("thread not reserved", err)
	}
	done := make(chan struct{})
	go func() { s.Close(); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("close waited for retry timer")
	}
	if calls.Load() != 1 {
		t.Fatal("retried after close")
	}
}

type retryQueueSender struct{ calls atomic.Int32 }

func (r *retryQueueSender) Send(context.Context, string, string, string) desktop.Result {
	return desktop.Result{Status: "failed", Detail: "unexpected steer"}
}
func (r *retryQueueSender) Start(context.Context, string, string, string) desktop.Result {
	if r.calls.Add(1) == 1 {
		return desktop.Result{Status: "failed", Retryable: true}
	}
	return desktop.Result{Status: "accepted", TurnID: "queue-turn"}
}
func TestQueuedDeliveryRetriesWithoutSteering(t *testing.T) {
	sender := &retryQueueSender{}
	s, err := Open(filepath.Join(t.TempDir(), "outbox"), sender)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	s.retryDelay = 5 * time.Millisecond
	s.Submit("retry-queued-0001", "thread", "queued body", "queue")
	ready := func(string) (bool, string) { return true, "completion-1" }
	s.checkQueue(ready)
	s.checkQueue(ready)
	e := waitEntry(t, s, "retry-queued-0001")
	if e.Status != "accepted" || e.Attempts != 2 || sender.calls.Load() != 2 || e.CompletionVersion != "completion-1" {
		t.Fatal(e)
	}
}
