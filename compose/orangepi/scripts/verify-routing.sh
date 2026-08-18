#!/bin/bash
set -e

# verify-routing.sh: Integration test that Caddy routing reaches the correct upstreams.
# This tests actual HTTP behavior, not just syntax or regex matching.

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

# Create a stub Caddyfile for the upstream that responds with the URI
STUB_CADDYFILE="$TMPDIR/stub-Caddyfile"
cat > "$STUB_CADDYFILE" << 'EOF'
:3101 {
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
