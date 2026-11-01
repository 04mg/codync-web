# codync-web: one binary with the web app inside.
#   make            build the app (npm) and the binary for this machine into bin/
#   make release    the app once, then binaries for Linux, macOS and Windows (amd64 + arm64) as archives in bin/release
#   make test       Go tests
VERSION ?= $(shell git describe --tags --match 'web-v*' --always 2>/dev/null | sed 's/^web-v//')
LDFLAGS := -s -w -X main.version=$(VERSION)
DESKTOP := ../desktop
PLATFORMS := linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64 windows/arm64
export CGO_ENABLED := 0
export GOTOOLCHAIN := local

.PHONY: all ui binary release test clean

all: ui binary

ui:
	cd $(DESKTOP) && npm ci --no-audit --no-fund && npm run build:web

binary:
	go build -trimpath -ldflags '$(LDFLAGS)' -o bin/codync-web .

release: ui
	rm -rf bin/release && mkdir -p bin/release
	@for p in $(PLATFORMS); do \
		os=$${p%/*}; arch=$${p#*/}; name=codync-web-$$os-$$arch; ext=; [ $$os = windows ] && ext=.exe; \
		echo "building $$name"; \
		GOOS=$$os GOARCH=$$arch go build -trimpath -ldflags '$(LDFLAGS)' -o bin/release/$$name/codync-web$$ext . || exit 1; \
		cp ../../LICENSE ../../NOTICE README.md bin/release/$$name/; \
		if [ $$os = windows ]; then (cd bin/release && zip -qr $$name.zip $$name); \
		else tar -C bin/release -czf bin/release/$$name.tar.gz $$name; fi; \
		rm -rf bin/release/$$name; \
	done
	cd bin/release && sha256sum * > SHA256SUMS

test:
	go test ./...

clean:
	rm -rf bin
