# Production web tier: a Vite build stage, then a Caddy image carrying the
# built bundle. The compose service is called `caddy` because that is what it
# runs; this file is called frontend.Dockerfile because that is what it builds.
FROM node:20-alpine AS build

WORKDIR /app

# VITE_API_URL is baked into the bundle at BUILD time -- it is read in more
# than twenty modules via import.meta.env, each falling back to
# http://localhost:13101 (frontend/src/config.js:4). A bundle built without it
# silently points every player at their own machine, so the build refuses
# rather than emitting one. On the Pi this value is the tunnel hostname, which
# changes on every restart while the trycloudflare phase lasts.
ARG VITE_API_URL

RUN if [ -z "$VITE_API_URL" ]; then \
      echo "ERROR: VITE_API_URL build-arg is required" >&2; exit 1; \
    fi; \
    if echo "$VITE_API_URL" | grep -qE 'localhost|127\.0\.0\.1'; then \
      echo "ERROR: VITE_API_URL is still the localhost default: $VITE_API_URL" >&2; \
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
