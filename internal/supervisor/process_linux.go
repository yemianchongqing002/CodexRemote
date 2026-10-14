package supervisor

import (
	"errors"
	"fmt"
	"os"
	"strings"
)

func processBirth(pid int) (string, error) {
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return "", err
	}
	i := strings.LastIndexByte(string(b), ')')
	if i < 0 {
		return "", errors.New("invalid process stat")
	}
	fields := strings.Fields(string(b[i+1:]))
	if len(fields) <= 19 {
		return "", errors.New("invalid process stat")
	}
	boot, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(boot)) + ":" + fields[19], nil
}
