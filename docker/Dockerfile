# syntax=docker/dockerfile:1

ARG NODE_VERSION=22.23.4

# `node:22-*-slim` omits armv7, so we base off Debian directly and drop in
# the official Node.js tarball keyed on TARGETPLATFORM.
FROM debian:trixie-slim AS base
WORKDIR /app

ARG TARGETPLATFORM
ARG NODE_VERSION

ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:/usr/local/bin:$PATH"

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl libatomic1 xz-utils \
    && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    case "$TARGETPLATFORM" in \
      "linux/amd64")   NODE_ARCH=x64 ;; \
      "linux/arm64")   NODE_ARCH=arm64 ;; \
      "linux/arm/v7")  NODE_ARCH=armv7l ;; \
      *) echo "Unsupported TARGETPLATFORM: $TARGETPLATFORM" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" -o /tmp/node.tar.xz; \
    tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner; \
    rm /tmp/node.tar.xz; \
    corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json LICENSE ./
COPY patches ./patches
COPY apps ./apps
COPY packages ./packages

# The web bundle is platform-independent, so this stage starts from a native
# Node image for BUILDPLATFORM; inheriting `base` would retain its
# target-platform filesystem and Node binary.
# https://github.com/docker/docs/blob/cf508182bf559e87e89dfa67052941b092439aea/_vendor/github.com/moby/buildkit/frontend/dockerfile/docs/reference.md#L648-L654
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-trixie-slim AS web-build
WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:/usr/local/bin:$PATH"
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json LICENSE ./
COPY patches ./patches
COPY apps ./apps
COPY packages ./packages

RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm run build:web

# `--prod` skips every workspace's devDependencies, most importantly
# `wrangler → miniflare → sharp@0.34.5` at the repo root, so the image does
# not carry a second sharp/libvips prebuilt.
# `--ignore-scripts` bypasses the root `prepare: husky` hook whose binary
# lives in devDependencies; nothing else in the tree needs an install
# script (sharp 0.33+ ships prebuilts through optional deps).
FROM base AS server
RUN pnpm install --frozen-lockfile --prod --ignore-scripts
COPY --from=web-build /app/apps/web/dist/client ./apps/web/dist/client
# The former nginx dashboard image exposed the repository license at /LICENSE.
# Keep that public path while the Node static handler owns the web bundle.
COPY LICENSE ./apps/web/dist/client/LICENSE

ENV NODE_ENV=production
ENV PORT=8788
ENV HOST=0.0.0.0
ENV FLOWAY_DB_PATH=/data/floway.db
ENV FLOWAY_FILES_DIR=/data/files

RUN mkdir -p /data/files

VOLUME ["/data"]
EXPOSE 8788

CMD ["pnpm", "--filter", "@floway-dev/platform-node", "run", "start:built"]
