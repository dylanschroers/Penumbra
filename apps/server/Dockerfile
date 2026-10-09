# The Penumbra server as a standalone container. Build from the repo root, since
# the server depends on packages/shared:
#
#   docker build -f apps/server/Dockerfile .
#
# deploy/compose.yaml does this for you and pairs it with a llama-server.

# Debian, not Alpine: better-sqlite3 is a native module and its prebuilt
# binaries target glibc.
FROM node:22-bookworm-slim AS build
# Toolchain for better-sqlite3, in case no prebuilt binary matches.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter @penumbra/server...
RUN pnpm --filter @penumbra/server build
# A self-contained copy with production dependencies only. dist is gitignored, so
# it is copied in explicitly rather than trusting deploy to pick it up.
RUN pnpm --filter @penumbra/server deploy --prod /out \
  && rm -rf /out/dist \
  && cp -r apps/server/dist /out/dist

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
  PORT=3000 \
  DB_PATH=/data/server.db \
  PENUMBRA_UPLOAD_DIR=/data/uploads \
  UNSLOTH_LAUNCH_CMD="" \
  UNSLOTH_STOP_CMD=""
# Launch/Stop are empty because the panel's buttons spawn Studio as a child of
# this process, which a container cannot do for a Studio running elsewhere.
WORKDIR /app
COPY --from=build --chown=node:node /out .
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
CMD ["node", "dist/main.js"]
