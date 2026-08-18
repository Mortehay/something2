# The deploy hook runs ON the board and drives docker compose there, so it
# needs the docker CLI and git as well as node. Everything comes from Alpine's
# packages: this is a listener on a public URL, and the smallest surface is
# worth more here than a convenient base image.
FROM node:20-alpine

RUN apk add --no-cache docker-cli docker-cli-compose git bash curl

# No dependencies to install: server.js uses node:http and node:crypto only.
COPY compose/orangepi/deploy-hook/server.js /srv/deploy-hook/server.js

# The deploy SCRIPT is not baked in. It comes from the board's clone at /app,
# which is mounted -- so a deploy always runs the version of deploy.sh that
# belongs to the commit being deployed, rather than whatever was current when
# this image happened to be built.

# git refuses to operate on a repository owned by another uid ("dubious
# ownership"). The clone belongs to the board's login user and this container
# is root, which is exactly that case -- and it surfaces as a confusing
# ownership error in the middle of a deploy rather than at startup.
RUN git config --global --add safe.directory /app

WORKDIR /app
CMD ["node", "/srv/deploy-hook/server.js"]
