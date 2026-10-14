package delivery

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"codexremote/internal/desktop"
)

type senderFunc func(context.Context, string, string, string) desktop.Result

func (f senderFunc) Send(c context.Context, t, id, text string) desktop.Result {
	return f(c, t, id, text)
}
func waitEntry(t *testing.T, s *Service, id string) Entry {
	t.Helper()
	for n := 0; n < 100; n++ {
		e, _ := s.Get(id)
		if e.Status != "pending" {
			return e
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("pending did not resolve")
	return Entry{}
}

func TestIdempotencySurvivesRestartWithoutPlaintext(t *testing.T) {
	var calls atomic.Int32
	sender := senderFunc(func(context.Context, string, string, string) desktop.Result {
		calls.Add(1)
		return desktop.Result{Status: "accepted", TurnID: "turn", Detail: "ok"}
	})
	path := filepath.Join(t.TempDir(), "outbox")
	s, e := Open(path, sender)
	if e != nil {
		t.Fatal(e)
	}
	const id = "0123456789abcdef0123456789abcdef"
	if _, e = s.Submit(id, "thread", "private prompt"); e != nil {
		t.Fatal(e)
	}
	if result := waitEntry(t, s, id); result.Status != "accepted" {
		t.Fatal(result)
	}
	if _, e = s.Submit(id, "thread", "private prompt"); e != nil {
		t.Fatal(e)
	}
	if _, e = s.Submit(id, "thread", "changed"); e != ErrConflict {
		t.Fatal("conflict missing")
	}
	s.Close()
	data, _ := os.ReadFile(path)
	if strings.Contains(string(data), "private prompt") {
		t.Fatal("plaintext persisted")
	}
	s, e = Open(path, sender)
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	result, e := s.Submit(id, "thread", "private prompt")
	if e != nil || result.Status != "accepted" || calls.Load() != 1 {
		t.Fatalf("replayed: %+v %v %d", result, e, calls.Load())
	}
}
func TestPendingRecoveryAndExclusiveLock(t *testing.T) {
	path := filepath.Join(t.TempDir(), "outbox")
	entry := Entry{ID: "0123456789abcdef", ThreadID: "thread", Status: "pending"}
	b, _ := json.Marshal(entry)
	os.WriteFile(path, append(append(b, '\n'), []byte(`{"partial"`)...), 0600)
	s, e := Open(path, senderFunc(func(context.Context, string, string, string) desktop.Result {
		t.Error("recovery must not dispatch")
		return desktop.Result{}
	}))
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	if r, ok := s.Get(entry.ID); !ok || r.Status != "unknown" {
		t.Fatal(r)
	}
	if second, e := Open(path, nil); e == nil {
		second.Close()
		t.Fatal("concurrent writer allowed")
	}
}
func TestValidationAndBusy(t *testing.T) {
	gate := make(chan struct{})
	s, e := Open(filepath.Join(t.TempDir(), "outbox"), senderFunc(func(context.Context, string, string, string) desktop.Result {
		<-gate
		return desktop.Result{Status: "failed"}
	}))
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	defer close(gate)
	if _, e = s.Submit("short", "t", "x"); e == nil {
		t.Fatal("bad id")
	}
	if _, e = s.Submit("0123456789abcdef", "t", strings.Repeat("x", 16385)); e == nil {
		t.Fatal("too long")
	}
	if _, e = s.Submit("0123456789abcdef", "t", "hello"); e != nil {
		t.Fatal(e)
	}
	if _, e = s.Submit("1123456789abcdef", "t", "other"); e != ErrBusy {
		t.Fatal("busy check")
	}
}

type queueSender struct{ starts, steers atomic.Int32 }

func (s *queueSender) Send(context.Context, string, string, string) desktop.Result {
	s.steers.Add(1)
	return desktop.Result{Status: "accepted"}
}
func (s *queueSender) Start(context.Context, string, string, string) desktop.Result {
	s.starts.Add(1)
	return desktop.Result{Status: "accepted", TurnID: "queued-turn"}
}
func TestQueueRestartCancelAndSeparateSteer(t *testing.T) {
	sender := &queueSender{}
	path := filepath.Join(t.TempDir(), "outbox")
	s, err := Open(path, sender)
	if err != nil {
		t.Fatal(err)
	}
	id := "queued-request-0001"
	if e, err := s.Submit(id, "t", "durable message", "queue"); err != nil || e.Status != "queued" {
		t.Fatal(e, err)
	}
	if _, err = s.Submit(id, "t", "durable message", "steer"); err != ErrConflict {
		t.Fatal("mode must be idempotency bound")
	}
	s.checkQueue(func(string) (bool, string) { return false, "active" })
	if sender.starts.Load() != 0 {
		t.Fatal("busy thread received queued input")
	}
	if _, err = s.Submit("steer-request-0001", "t", "guide now", "steer"); err != nil {
		t.Fatal(err)
	}
	waitEntry(t, s, "steer-request-0001")
	s.Close()
	s, err = Open(path, sender)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if len(s.Queued("t")) != 1 {
		t.Fatal("lost durable queue")
	}
	ready := func(string) (bool, string) { return true, "completed-1" }
	s.checkQueue(ready)
	if sender.starts.Load() != 0 {
		t.Fatal("must confirm stable completion twice")
	}
	s.checkQueue(ready)
	if e := waitEntry(t, s, id); e.Status != "accepted" {
		t.Fatal(e)
	}
	if sender.starts.Load() != 1 || sender.steers.Load() != 1 {
		t.Fatal("wrong dispatch path")
	}
	if _, err = os.Stat(path + ".queue/" + id); !os.IsNotExist(err) {
		t.Fatal("body not removed")
	}
	if _, err = s.Submit("queued-request-0003", "t", "cancel me", "queue"); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Cancel("queued-request-0003"); err != nil {
		t.Fatal(err)
	}
	s.checkQueue(ready)
	s.checkQueue(ready)
	if sender.starts.Load() != 1 {
		t.Fatal("cancelled entry dispatched")
	}
}

func TestFiveQueuedMessagesAndCompletionVersion(t *testing.T) {
	sender := &queueSender{}
	path := filepath.Join(t.TempDir(), "outbox")
	s, err := Open(path, sender)
	if err != nil {
		t.Fatal(err)
	}
	ids := []string{"five-queue-request-01", "five-queue-request-02", "five-queue-request-03", "five-queue-request-04", "five-queue-request-05"}
	for _, id := range ids {
		if _, err := s.Submit(id, "thread", id, "queue"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.Submit("five-queue-request-06", "thread", "sixth", "queue"); err == nil {
		t.Fatal("sixth message accepted")
	}
	if _, err := s.Submit(ids[0], "thread", ids[0], "queue"); err != nil {
		t.Fatal("idempotent retry rejected", err)
	}
	s.Close()
	s, err = Open(path, sender)
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Queued("thread")) != 5 {
		t.Fatal("queue not restored")
	}
	ready := func(string) (bool, string) { return true, "completion-one" }
	s.checkQueue(ready)
	s.checkQueue(ready)
	if e := waitEntry(t, s, ids[0]); e.Status != "accepted" {
		t.Fatal(e)
	}
	s.checkQueue(ready)
	s.checkQueue(ready)
	if sender.starts.Load() != 1 {
		t.Fatal("reused stale completion")
	}
	s.Close()
	s, err = Open(path, sender)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	s.checkQueue(ready)
	s.checkQueue(ready)
	if sender.starts.Load() != 1 {
		t.Fatal("reused completion after restart")
	}
	if _, err := s.Cancel(ids[1]); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Submit("five-queue-request-06", "thread", "sixth", "queue"); err != nil {
		t.Fatal(err)
	}
	next := func(string) (bool, string) { return true, "completion-two" }
	s.checkQueue(next)
	s.checkQueue(next)
	if e := waitEntry(t, s, ids[2]); e.Status != "accepted" {
		t.Fatal("did not skip cancelled message in FIFO order", e)
	}
	if sender.starts.Load() != 2 {
		t.Fatal("unexpected dispatch count")
	}
}

type creatorFunc func(context.Context, string, string) (string, error)

func (f creatorFunc) Create(c context.Context, p, t string) (string, error) { return f(c, p, t) }
func TestCreateIdempotency(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "outbox"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var calls atomic.Int32
	c := creatorFunc(func(context.Context, string, string) (string, error) { calls.Add(1); return "new-thread", nil })
	id := "create-request-0001"
	if _, err = s.Create(id, "/project", "first message", c); err != nil {
		t.Fatal(err)
	}
	if e := waitEntry(t, s, id); e.Status != "created" || e.ThreadID != "new-thread" {
		t.Fatal(e)
	}
	if _, err = s.Create(id, "/project", "first message", c); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Create(id, "/project", "different", c); err != ErrConflict {
		t.Fatal("create conflict missing")
	}
	if calls.Load() != 1 {
		t.Fatal("duplicate create")
	}
}

func TestPromoteQueuedMessageExactlyOnce(t *testing.T) {
	sender := &queueSender{}
	path := filepath.Join(t.TempDir(), "outbox")
	s, err := Open(path, sender)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	id := "promote-request-0001"
	if _, err = s.Submit(id, "thread", "queued original text", "queue"); err != nil {
		t.Fatal(err)
	}
	view := s.QueueStatus("thread")
	if len(view) != 1 || view[0].Text != "queued original text" {
		t.Fatal(view)
	}
	if _, err = s.Promote(id); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Promote(id); err != nil {
		t.Fatal(err)
	}
	result := waitEntry(t, s, id)
	if result.Status != "accepted" {
		t.Fatal(result)
	}
	s.checkQueue(func(string) (bool, string) { return true, "idle" })
	s.checkQueue(func(string) (bool, string) { return true, "idle" })
	if sender.steers.Load() != 1 || sender.starts.Load() != 0 {
		t.Fatal("promotion duplicated or auto-dispatched")
	}
	if _, err = os.Stat(path + ".queue/" + id); !os.IsNotExist(err) {
		t.Fatal("promoted body not cleaned")
	}
	if _, err = s.Cancel(id); err == nil {
		t.Fatal("accepted message cannot be deleted")
	}
	if _, err = s.Submit("promote-request-0002", "thread", "delete me", "queue"); err != nil {
		t.Fatal(err)
	}
	s.Cancel("promote-request-0002")
	if _, err = s.Promote("promote-request-0002"); err == nil {
		t.Fatal("deleted message promoted")
	}
}

func TestCreateHandoffFailureIsNotSuccess(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "outbox"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var calls atomic.Int32
	c := creatorFunc(func(context.Context, string, string) (string, error) {
		calls.Add(1)
		return "saved-thread", errors.New("桌面接管未确认")
	})
	id := "create-handoff-failure-01"
	if _, err = s.Create(id, "/project", "first", c); err != nil {
		t.Fatal(err)
	}
	e := waitEntry(t, s, id)
	if e.Status != "created_unconfirmed" || e.ThreadID != "saved-thread" || e.Detail != "桌面接管未确认" {
		t.Fatal(e)
	}
	if _, err = s.Create(id, "/project", "first", c); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatal("partial creation was duplicated")
	}
}

func TestQueueWorkerWakesAndConfirmsWithoutIdlePolling(t *testing.T) {
	sender := &queueSender{}
	s, err := Open(filepath.Join(t.TempDir(), "outbox"), sender)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	calls := make(chan time.Time, 8)
	done := make(chan struct{})
	go func() {
		defer close(done)
		s.RunQueue(ctx, func(string) (bool, string) { calls <- time.Now(); return true, "completed" })
	}()
	select {
	case <-calls:
		t.Fatal("empty queue read disk")
	case <-time.After(50 * time.Millisecond):
	}
	start := time.Now()
	if _, err = s.Submit("fast-queue-request-01", "thread", "hello", "queue"); err != nil {
		t.Fatal(err)
	}
	var first, second time.Time
	select {
	case first = <-calls:
	case <-time.After(time.Second):
		t.Fatal("enqueue failed to wake")
	}
	select {
	case second = <-calls:
	case <-time.After(2 * time.Second):
		t.Fatal("completion check delayed")
	}
	if second.Sub(first) < queueCheckInterval-20*time.Millisecond {
		t.Fatal("stability interval skipped")
	}
	if first.Sub(start) > time.Second {
		t.Fatal("first check delayed")
	}
	if e := waitEntry(t, s, "fast-queue-request-01"); e.Status != "accepted" {
		t.Fatal(e)
	}
	cancel()
	<-done
}

func TestDeliveryChangesBroadcast(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "outbox"), &queueSender{})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	a, b := s.Changes(), s.Changes()
	if _, err = s.Submit("notify-queue-request-01", "thread", "hello", "queue"); err != nil {
		t.Fatal(err)
	}
	for _, ch := range []<-chan struct{}{a, b} {
		select {
		case <-ch:
		default:
			t.Fatal("viewer not notified")
		}
	}
	select {
	case <-s.Changes():
		t.Fatal("new subscription already closed")
	default:
	}
}
