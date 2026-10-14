package desktop

import (
	"context"
	"encoding/json"
	"errors"
)

// Pin the observed turn so a delayed stop cannot interrupt a newer answer.
func (c *Client) Interrupt(ctx context.Context, thread, turn string) error {
	if !threadIDPattern.MatchString(thread) || turn == "" {
		return errors.New("聊天或当前轮标识无效")
	}
	w, err := c.connect(ctx)
	if err != nil {
		return err
	}
	defer w.conn.Close()
	owner, err := w.owner(thread)
	if err != nil {
		return err
	}
	r, sent, err := w.request("thread-follower-interrupt-turn", map[string]any{"conversationId": thread, "mode": "user-stop", "expectedTurnId": turn}, 4, owner)
	if err != nil {
		if sent {
			return errors.New("停止结果未确认，请刷新聊天核对")
		}
		return err
	}
	if r.ResultType != "success" {
		return errors.New("桌面未确认停止：" + short(r.Error))
	}
	var payload struct {
		Result struct {
			OK     bool   `json:"ok"`
			TurnID string `json:"interruptedTurnId"`
		} `json:"result"`
	}
	if json.Unmarshal(r.Result, &payload) != nil || !payload.Result.OK || payload.Result.TurnID != turn {
		return errors.New("该轮已结束或停止未确认，请刷新聊天")
	}
	return nil
}
