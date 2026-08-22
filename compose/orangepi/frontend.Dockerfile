# Production web tier: a Vite build stage, then a Caddy image carrying the
# built bundle. The compose service is called `caddy` because that is what it
# runs; this file is called frontend.Dockerfile because that is what it builds.
FROM node:20-alpine AS build

WORKDIR /app

# VITE_API_URL is baked into the bundle at BUILD time -- it is read via the
# single shared frontend/src/config.js (every one of the twenty-odd modules
# that talks to the backend imports API_URL from there rather than reading
# import.meta.env itself). Unset is now a VALID, and the NORMAL, production
# value: it means same-origin, i.e. relative `/api/...` URLs that go through
# whatever is serving the page -- Caddy in this stack, which proxies both
# backend surfaces on the one hostname the tunnel exposes. That is what makes
# this stack survive a tunnel restart without a rebuild: the hostname is
# random and changes every time (trycloudflare), so the bundle can no longer
# afford to have it baked in.
#
# Set VITE_API_URL only for a split-origin deployment, where the frontend and
# backend are served from genuinely different hosts. Whether set or unset,
# the guard below still refuses a localhost value -- that failure mode (every
# player silently pointed at their own machine) is unchanged.
ARG VITE_API_URL

# Opt-out for local workstation verification ONLY (README's "Production stack
# (local verification)" section) -- a real deployment must never set this.
# Defaults empty, which keeps the localhost check active. The check below is
# case-INSENSITIVE specifically so this can't be sidestepped by spelling the
# host `LocalHost` or `LOCALHOST` instead of asking for the real opt-out.
ARG ALLOW_LOCALHOST_API_URL

RUN if [ -n "$VITE_API_URL" ] && [ "$ALLOW_LOCALHOST_API_URL" != "1" ] && echo "$VITE_API_URL" | grep -qiE 'localhost|127\.0\.0\.1'; then \
      echo "ERROR: VITE_API_URL is still the localhost default: $VITE_API_URL" >&2; \
      echo "ERROR: for LOCAL VERIFICATION ONLY, pass --build-arg ALLOW_LOCALHOST_API_URL=1 to opt out. A real deployment must NOT set this." >&2; \
      exit 1; \
    fi

COPY frontend/package.json frontend/package-lock.json ./

# No --omit=dev here: vite itself is a dev dependency, so the build needs them.
RUN npm ci

COPY frontend/ ./

ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

FROM caddy:2-alpine

COPY --from=build /app/dist /srv
COPY compose/orangepi/caddy/Caddyfile /etc/caddy/Caddyfile
