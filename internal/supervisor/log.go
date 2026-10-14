package supervisor

import (
	"fmt"
	"log"
	"os"
	"time"
)

// Do not include IPC instance credentials, access tokens or business payloads.
func trace(r record, event, format string, args ...any) {
	log.Printf("guardian time=%s event=%s role=%s pid=%d session=%q detail=%q",
		time.Now().Format(time.RFC3339Nano), event, r.Role, r.PID, r.Session, fmt.Sprintf(format, args...))
}

func operationTrace(event, format string, args ...any) {
	trace(record{Role: "control", PID: os.Getpid()}, event, format, args...)
}
