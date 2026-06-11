.PHONY: build run test tidy lint vet

build:
	go build -o bin/engine ./cmd/engine

run:
	go run ./cmd/engine

test:
	go test ./...

tidy:
	go mod tidy

vet:
	go vet ./...
