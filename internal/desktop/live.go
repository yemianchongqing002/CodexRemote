package desktop

import (
	"context"
	"errors"
)

func (c *Client) liveWire(ctx context.Context, thread string) (*wire, string, error) {
	if !threadIDPattern.MatchString(thread) {
		return nil, "", errors.New("聊天标识无效")
	}
	w, err := c.connect(ctx)
	if err != nil {
		return nil, "", err
	}
	owner, err := w.owner(thread)
	if err != nil {
		w.conn.Close()
		return nil, "", err
	}
	return w, owner, nil
}
func (c *Client) Live(ctx context.Context, thread string) (LiveState, error) {
	w, owner, closeLive, err := c.openLive(ctx, thread)
	if err != nil {
		return LiveState{}, err
	}
	defer closeLive()
	return w.snapshot(thread, owner)
}

// openLive owns the cancellation hook and cleanup shared by reads and controls.
func (c *Client) openLive(ctx context.Context, thread string) (*wire, string, func(), error) {
	w, owner, err := c.liveWire(ctx, thread)
	if err != nil {
		return nil, "", nil, err
	}
	stop := context.AfterFunc(ctx, func() { _ = w.conn.Close() })
	return w, owner, func() {
		stop()
		_ = w.conn.Close()
	}, nil
}
