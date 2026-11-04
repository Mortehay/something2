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

# The seeds hold about 675 MB (textures and audio) that almost never change, while the code changes on
# every push. A single `COPY backend/ ./` put both in ONE layer, so every Update re-downloaded the
# seeds along with the code (SOMET-722). They get their own layers FIRST, and the code is copied
# directory by directory after them, so a code change only produces a small new layer and the seed
# layers keep the same digest (the board already has them). `.dockerignore` cannot exclude per COPY,
# hence the explicit list; orangepi_images.test.js fails if a top-level backend entry is missing here.
#
# .dockerignore excludes backend/node_modules and backend/tests, so none of this clobbers the modules
# installed above.
COPY backend/seeds/textures ./seeds/textures
COPY backend/seeds/audio ./seeds/audio
COPY backend/seeds/sync ./seeds/sync
COPY backend/seeds/data ./seeds/data
COPY backend/seeds/maps ./seeds/maps
COPY backend/seeds/*.js ./seeds/
COPY backend/migrations ./migrations
COPY backend/scripts ./scripts
COPY backend/tools ./tools
COPY backend/src ./src

# node:20-alpine ships an unprivileged `node` user. The app only reads its
# own source at runtime, so root ownership of /app is fine.
USER node

# The internal port. backend/src/index.js honours PORT and falls back to 3101.
EXPOSE 3101

CMD ["node", "src/index.js"]
