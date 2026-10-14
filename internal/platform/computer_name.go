package platform

import (
	"context"
	"net"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

// ComputerName returns the operating system's display name, never an IP address.
func ComputerName() string {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	var command string
	var args []string
	switch runtime.GOOS {
	case "darwin":
		command, args = "/usr/sbin/scutil", []string{"--get", "ComputerName"}
	case "linux":
		command, args = "hostnamectl", []string{"--pretty"}
	}
	if command != "" {
		if output, err := exec.CommandContext(ctx, command, args...).Output(); err == nil {
			if name := strings.TrimSpace(string(output)); name != "" && net.ParseIP(name) == nil {
				return name
			}
		}
	}
	// Windows uses its system computer name; other systems fall back when no display name exists.
	name, _ := os.Hostname()
	if name = strings.TrimSpace(name); name != "" && net.ParseIP(name) == nil {
		return name
	}
	return "我的电脑"
}
