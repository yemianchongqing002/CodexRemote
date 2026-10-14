package desktop

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"testing"
)

type frameWriter struct {
	net.Conn
	data []byte
	n    int
	err  error
}

func (c *frameWriter) Write(b []byte) (int, error) {
	c.data = append([]byte(nil), b...)
	if c.n < 0 {
		return len(b), c.err
	}
	return c.n, c.err
}

func TestWriteFrameDeliveryStatus(t *testing.T) {
	for _, tc := range []struct {
		name string
		n    int
		err  error
		want error
		sent bool
	}{
		{"complete", -1, nil, nil, true},
		{"empty-write", 0, nil, io.ErrShortWrite, false},
		{"partial-write", 2, nil, io.ErrShortWrite, true},
		{"disconnected", 0, net.ErrClosed, net.ErrClosed, false},
		{"partial-error", 2, net.ErrClosed, net.ErrClosed, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			conn := &frameWriter{n: tc.n, err: tc.err}
			sent, err := (&wire{conn: conn}).writeFrame(map[string]string{"type": "request"})
			if sent != tc.sent || !errors.Is(err, tc.want) {
				t.Fatalf("sent=%v err=%v; want sent=%v err=%v", sent, err, tc.sent, tc.want)
			}
			if len(conn.data) < 4 || binary.LittleEndian.Uint32(conn.data[:4]) != uint32(len(conn.data)-4) || !bytes.Equal(conn.data[4:], []byte(`{"type":"request"}`)) {
				t.Fatalf("invalid frame: %q", conn.data)
			}
		})
	}
}

func TestWriteFrameEncodingFailureDoesNotSend(t *testing.T) {
	conn := &frameWriter{n: -1}
	sent, err := (&wire{conn: conn}).writeFrame(make(chan int))
	if err == nil || sent || conn.data != nil {
		t.Fatalf("encoding failure wrote to connection: sent=%v err=%v data=%q", sent, err, conn.data)
	}
}
