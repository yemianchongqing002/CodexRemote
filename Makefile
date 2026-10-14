GO ?= go

.PHONY: build test check
build:
	$(GO) build -trimpath -ldflags='-s -w' -o bin/codex-remote ./cmd/codex-remote
test:
	$(GO) test -race ./...
check:
	$(GO) vet ./...
