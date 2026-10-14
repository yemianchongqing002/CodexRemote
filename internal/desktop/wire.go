package desktop

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"time"
)

var errDesktopIncompatible = errors.New("桌面接口返回了不兼容的初始化结果")

type wire struct {
	home   string
	conn   net.Conn
	client string
}
type response struct {
	Type       string          `json:"type"`
	RequestID  string          `json:"requestId"`
	Method     string          `json:"method"`
	ResultType string          `json:"resultType"`
	Error      string          `json:"error"`
	Owner      string          `json:"handledByClientId"`
	Result     json.RawMessage `json:"result"`
}

func uid() string {
	var b [16]byte
	_, e := rand.Read(b[:])
	if e != nil {
		panic(e)
	}
	return hex.EncodeToString(b[:])
}
func (c *Client) connect(ctx context.Context) (*wire, error) {
	conn, e := dialDesktop(ctx, c.Socket)
	if e != nil {
		return nil, e
	}
	deadline := time.Now().Add(16 * time.Second)
	if limit, ok := ctx.Deadline(); ok && limit.Before(deadline) {
		deadline = limit
	}
	_ = conn.SetDeadline(deadline)
	w := &wire{conn: conn, client: "codex-remote", home: c.Home}
	r, _, e := w.request("initialize", map[string]any{"clientType": "codex-remote"}, 0, "")
	if e != nil {
		conn.Close()
		return nil, errors.New("桌面接口初始化失败")
	}
	if r.ResultType != "success" {
		conn.Close()
		return nil, errDesktopIncompatible
	}
	var v struct {
		ClientID string `json:"clientId"`
	}
	if json.Unmarshal(r.Result, &v) != nil || v.ClientID == "" {
		conn.Close()
		return nil, errDesktopIncompatible
	}
	w.client = v.ClientID
	return w, nil
}
func (w *wire) request(method string, params any, version int, owner string) (response, bool, error) {
	id := uid()
	request := map[string]any{"type": "request", "requestId": id, "sourceClientId": w.client, "version": version, "method": method, "params": params, "timeoutMs": 12000}
	if owner != "" {
		request["targetClientId"] = owner
	}
	sent, e := w.writeFrame(request)
	if e != nil {
		return response{}, sent, e
	}
	for {
		var length [4]byte
		if _, e = io.ReadFull(w.conn, length[:]); e != nil {
			return response{}, sent, e
		}
		size := binary.LittleEndian.Uint32(length[:])
		if size == 0 || size > 8<<20 {
			return response{}, sent, errors.New("桌面响应超出限制")
		}
		body := make([]byte, size)
		if _, e = io.ReadFull(w.conn, body); e != nil {
			return response{}, sent, e
		}
		var r response
		if e = json.Unmarshal(body, &r); e != nil {
			return response{}, sent, e
		}
		if r.Type == "client-discovery-request" {
			// This viewer never claims ownership or handles incoming requests.
			if _, e = w.writeFrame(map[string]any{"type": "client-discovery-response", "requestId": r.RequestID, "response": map[string]bool{"canHandle": false}}); e != nil {
				return response{}, sent, e
			}
			continue
		}
		if r.Type == "response" && r.RequestID == id {
			return r, sent, nil
		}
	}
}
func (w *wire) owner(thread string) (string, error) {
	r, _, e := w.request("thread-owner-discovery", map[string]string{"hostId": "local", "conversationId": thread}, 1, "")
	if e != nil {
		return "", errors.New("桌面聊天探测超时，请检查目标电脑")
	}
	if r.ResultType != "success" || r.Owner == "" {
		return "", fmt.Errorf("%w；请在目标电脑打开该聊天后重试（桌面返回：%s）", errOwnerUnavailable, short(r.Error))
	}
	return r.Owner, nil
}

// writeFrame reports whether any bytes were sent so callers never retry an
// operation whose receipt is uncertain.
func (w *wire) writeFrame(value any) (bool, error) {
	body, err := json.Marshal(value)
	if err != nil {
		return false, err
	}
	frame := make([]byte, 4+len(body))
	binary.LittleEndian.PutUint32(frame, uint32(len(body)))
	copy(frame[4:], body)
	n, err := w.conn.Write(frame)
	if err == nil && n != len(frame) {
		err = io.ErrShortWrite
	}
	return n > 0, err
}
