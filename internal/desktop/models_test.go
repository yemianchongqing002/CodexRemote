package desktop

import (
	"context"
	"testing"
)

func TestModelSettingsUseAdvertisedCapabilities(t *testing.T) {
	models := []Model{{Model: "example", Efforts: []ReasoningOption{{Effort: "medium"}, {Effort: "high"}}, Tiers: []ServiceTier{{ID: "priority"}}}}
	if err := ValidateModelSettings(models, ModelSettings{Model: "example", Effort: "high", Fast: true}); err != nil {
		t.Fatal(err)
	}
	for _, choice := range []ModelSettings{{Model: "invented", Effort: "high"}, {Model: "example", Effort: "ultra"}} {
		if ValidateModelSettings(models, choice) == nil {
			t.Fatal("unadvertised setting accepted", choice)
		}
	}
	models[0].Tiers = nil
	if ValidateModelSettings(models, ModelSettings{Model: "example", Effort: "medium", Fast: true}) == nil {
		t.Fatal("unsupported Fast accepted")
	}
}

func TestSettingsTravelWithStartOnly(t *testing.T) {
	for _, fast := range []bool{false, true} {
		called := make(chan map[string]any, 1)
		c := fakeSocket(t, func(r map[string]any) map[string]any {
			called <- r
			return map[string]any{"resultType": "success", "result": map[string]any{"result": map[string]any{"turnId": "turn"}}}
		})
		result := c.StartWithSettings(context.Background(), "00000000-0000-0000-0000-000000000001", "request-id", "hello", nil, &ModelSettings{Model: "example", Effort: "high", Fast: fast})
		if result.Status != "accepted" {
			t.Fatal(result)
		}
		r := <-called
		if r["method"] != "thread-follower-start-turn" || r["version"] != float64(2) {
			t.Fatal(r)
		}
		start := r["params"].(map[string]any)["turnStart"].(map[string]any)
		req := start["request"].(map[string]any)
		if len(req) != 6 || req["model"] != "example" || req["effort"] != "high" {
			t.Fatal(req)
		}
		if fast && req["serviceTier"] != "priority" || !fast && req["serviceTier"] != nil {
			t.Fatal(req)
		}
		if start["context"].(map[string]any)["inheritThreadSettings"] != true {
			t.Fatal(start)
		}
	}
}
func TestInterruptPinsObservedTurn(t *testing.T) {
	called := make(chan map[string]any, 1)
	c := fakeSocket(t, func(r map[string]any) map[string]any {
		called <- r
		return map[string]any{"resultType": "success", "result": map[string]any{"result": map[string]any{"ok": true, "interruptedTurnId": "observed"}}}
	})
	if err := c.Interrupt(context.Background(), "00000000-0000-0000-0000-000000000001", "observed"); err != nil {
		t.Fatal(err)
	}
	r := <-called
	p := r["params"].(map[string]any)
	if r["method"] != "thread-follower-interrupt-turn" || r["version"] != float64(4) || p["expectedTurnId"] != "observed" || p["mode"] != "user-stop" {
		t.Fatal(r)
	}
}
func TestInterruptRequiresMatchingReceipt(t *testing.T) {
	c := fakeSocket(t, func(r map[string]any) map[string]any {
		return map[string]any{"resultType": "success", "result": map[string]any{"result": map[string]any{"ok": true, "interruptedTurnId": nil}}}
	})
	if c.Interrupt(context.Background(), "00000000-0000-0000-0000-000000000001", "observed") == nil {
		t.Fatal("unconfirmed stop accepted")
	}
}
