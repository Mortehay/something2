# Production backend image. Unlike compose/develop/backend.Dockerfile, which
# ends in `tail -f /dev/null` so `make dev` can exec nodemon into a container
# with the host checkout bind-mounted, this image IS the service: no bind
# mount, no nodemon, no source volume.
FROM node:20-alpine

WORKDIR /app

# Manifests first, so the dependency layer caches independently of source
# changes. On the Pi's fallback build path this is the difference between a
# rebuild that reinstalls everything and one that does not.
COPY backend/package.json backend/package-lock.json ./

# `npm ci` installs exactly the lockfile; npm's mutable dependency resolver
# may pick versions that drift from what was tested. --omit=dev drops nodemon
# and supertest but KEEPS node-pg-migrate, which is a production dependency
# precisely because migrations run as their own deploy step.
RUN npm ci --omit=dev

# .dockerignore excludes backend/node_modules, so this does not clobber the
# modules installed above.
COPY backend/ ./

# node:20-alpine ships an unprivileged `node` user. The app only reads its
# own source at runtime, so root ownership of /app is fine.
USER node

# The internal port. backend/src/index.js honours PORT and falls back to 3101.
EXPOSE 3101

CMD ["node", "src/index.js"]
