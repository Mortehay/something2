#!/bin/bash
set -e

# verify-routing.sh: Integration test that Caddy routing reaches the correct upstreams.
# This tests actual HTTP behavior, not just syntax or regex matching -- including
# that a real websocket upgrade handshake to /authority is forwarded and its 101
# response relayed back, not just that a plain GET reaches the right path (I3).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CADDYFILE="$REPO_ROOT/compose/orangepi/caddy/Caddyfile"
TMPDIR=$(mktemp -d)
NETWORK_NAME="orangepi-verify-$$"
BACKEND_CONTAINER="orangepi-backend-$$"
CADDY_CONTAINER="orangepi-caddy-$$"

# Cleanup on exit, including on failure
cleanup() {
	echo "Cleaning up containers and network..."
	docker rm -f "$BACKEND_CONTAINER" "$CADDY_CONTAINER" 2>/dev/null || true
	docker network rm "$NETWORK_NAME" 2>/dev/null || true
	rm -rf "$TMPDIR"
}
trap cleanup EXIT

echo "Setting up test environment..."

# Create the network
docker network create "$NETWORK_NAME"

# Create a stub Caddyfile for the upstream that responds with the URI, and
# separately accepts a genuine websocket upgrade handshake (matched on the
# actual Connection/Upgrade request headers, then answering with a real
# 101 plus the Connection/Upgrade response headers an upgrade requires --
# without those response headers, Caddy's reverse_proxy does NOT treat the
# backend's 101 as an upgrade and rewrites it to a plain 200 to the client,
# which is exactly the silent failure mode this test exists to catch).
STUB_CADDYFILE="$TMPDIR/stub-Caddyfile"
cat > "$STUB_CADDYFILE" << 'EOF'
:3101 {
	@websocket {
		header Connection *Upgrade*
		header Upgrade websocket
	}
	handle @websocket {
		header Connection Upgrade
		header Upgrade websocket
		respond "" 101
	}
	respond "BACKEND-GOT {uri}" 200
}
EOF

# Create an index.html marker for the SPA
TMPDIR_SRV="$TMPDIR/srv"
mkdir -p "$TMPDIR_SRV"
cat > "$TMPDIR_SRV/index.html" << 'EOF'
SPA-MARKER
EOF

echo "Starting stub upstream on backend:3101..."
docker run -d \
	--name "$BACKEND_CONTAINER" \
	--network "$NETWORK_NAME" \
	--network-alias backend \
	-v "$STUB_CADDYFILE:/etc/caddy/Caddyfile:ro" \
	caddy:2-alpine \
	caddy run --config /etc/caddy/Caddyfile > /dev/null

# Wait for stub to be ready
sleep 1

echo "Starting Caddy with the real Caddyfile..."
docker run -d \
	--name "$CADDY_CONTAINER" \
	--network "$NETWORK_NAME" \
	-p 8080:80 \
	-v "$CADDYFILE:/etc/caddy/Caddyfile:ro" \
	-v "$TMPDIR_SRV:/srv:ro" \
	caddy:2-alpine \
	caddy run --config /etc/caddy/Caddyfile > /dev/null

# Wait for Caddy to be ready
sleep 1

echo "Testing routes..."

# Test function: check that a path reaches the correct destination
test_route() {
	local path=$1
	local expected=$2
	local description=$3

	response=$(curl -s "http://localhost:8080$path" 2>&1)

	if echo "$response" | grep -q "$expected"; then
		echo "  ✓ $description: $path → $expected"
		return 0
	else
		echo "  ✗ $description: $path"
		echo "    Expected substring: $expected"
		echo "    Got: $response"
		return 1
	fi
}

failed=0

# Test that API requests reach the backend
test_route "/api/health" "BACKEND-GOT /api/health" "API health check" || failed=1
test_route "/api/auth/login" "BACKEND-GOT /api/auth/login" "API auth endpoint" || failed=1
test_route "/api/worlds/12/links" "BACKEND-GOT /api/worlds/12/links" "API multi-segment path" || failed=1

# Test that authority requests reach the backend
test_route "/authority" "BACKEND-GOT /authority" "Authority endpoint" || failed=1

# Test that a genuine websocket upgrade handshake through Caddy reaches the
# backend AND that the backend's 101 response is relayed back to the client.
# A plain GET (the test above) only proves path routing -- it says nothing
# about upgrade forwarding, and a broken proxy that mangles the upgrade still
# serves a perfectly good-looking page while the game itself is unplayable.
# This is the most load-bearing behaviour in the whole stack: the client's
# WebSocket connection to /authority (frontend/src/js/net/*) IS the game.
test_websocket_upgrade() {
	local description="WebSocket upgrade handshake"
	# A dummy but well-formed Sec-WebSocket-Key: 16 random-looking bytes,
	# base64-encoded, as RFC 6455 requires. Its actual value doesn't matter
	# here -- the stub doesn't validate or echo Sec-WebSocket-Accept, it just
	# has to be present and base64 for a compliant server to accept the
	# handshake at all.
	local ws_key
	ws_key=$(echo -n "verify-routing-dummy-key" | base64)

	# --max-time bounds this: curl correctly keeps the connection open after
	# a real 101 (there is more raw-protocol data to come on a real upgrade),
	# and our stub never sends any, so curl would otherwise hang until the
	# script's own timeout. -D - dumps response headers to stdout, -o
	# /dev/null discards the (absent) body, so a timeout after headers are
	# already received is a successful read, not a failure.
	# `|| true`: curl exits 28 on the --max-time cutoff, which is the EXPECTED
	# outcome on a real 101 (there's no more data coming from the stub, so
	# curl times out waiting rather than getting a clean EOF). Under `set -e`
	# an unguarded failing assignment here would abort the whole script, not
	# just this check -- the actual pass/fail signal is the header content
	# grepped below, not curl's own exit code.
	local headers
	headers=$(curl -s -D - -o /dev/null --max-time 3 \
		-H "Connection: Upgrade" \
		-H "Upgrade: websocket" \
		-H "Sec-WebSocket-Key: $ws_key" \
		-H "Sec-WebSocket-Version: 13" \
		"http://localhost:8080/authority" 2>&1) || true

	if echo "$headers" | grep -qi "^HTTP/1\.1 101"; then
		echo "  ✓ $description: /authority → 101 Switching Protocols"
		return 0
	else
		echo "  ✗ $description: /authority"
		echo "    Expected: HTTP/1.1 101 Switching Protocols"
		echo "    Got:"
		echo "$headers" | sed 's/^/      /'
		return 1
	fi
}
test_websocket_upgrade || failed=1

# Test that SPA routes are served the index.html marker
test_route "/" "SPA-MARKER" "SPA root" || failed=1
test_route "/some/spa/route" "SPA-MARKER" "SPA deep route" || failed=1

if [ $failed -ne 0 ]; then
	echo ""
	echo "FAILED: Routing verification failed. One or more paths did not reach the expected destination."
	exit 1
fi

echo ""
echo "SUCCESS: All routing tests passed."
exit 0
