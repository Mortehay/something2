# syntax=docker/dockerfile:1
#
# Dev image: source is bind-mounted from ./engine in compose, and `go run`
# rebuilds on container start. `make` and `go` are available for in-container
# iteration. Mirrors the backend's "ship the toolchain, run from sources" pattern.
FROM golang:1.22-alpine

RUN apk add --no-cache make ca-certificates tzdata git

WORKDIR /app

# Pre-warm the module cache. go.mod/go.sum will also exist via the bind mount,
# but caching here keeps `docker build` useful without a host checkout.
COPY engine/go.mod engine/go.sum* ./
RUN go mod download

ENV CGO_ENABLED=0
EXPOSE 8080

# Idle by default — same pattern as the backend container. Shell in via
# `make engine-shell` and run `make run` (or `make build && /app/bin/engine`)
# to start the engine against the bind-mounted sources.
CMD ["tail", "-f", "/dev/null"]
