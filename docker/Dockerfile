# syntax=docker/dockerfile:1

# `node:22-*-slim` skips riscv64, so we base off Debian directly and drop
# in the official Node.js tarball keyed on TARGETPLATFORM. `trixie-slim`
# gives us glibc 2.41, which the sharp riscv64 prebuilt requires.
FROM debian:trixie-slim AS base
WORKDIR /app

ARG TARGETPLATFORM
ARG NODE_VERSION=22.23.1

ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:/usr/local/bin:$PATH"

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl libatomic1 xz-utils \
    && rm -rf /var/lib/apt/lists/*

# riscv64 lives on unofficial-builds; the other tier-1 arches are on
# nodejs.org proper.
RUN set -eux; \
    case "$TARGETPLATFORM" in \
      "linux/amd64")   NODE_ARCH=x64;     NODE_HOST=https://nodejs.org/dist ;; \
      "linux/arm64")   NODE_ARCH=arm64;   NODE_HOST=https://nodejs.org/dist ;; \
      "linux/arm/v7")  NODE_ARCH=armv7l;  NODE_HOST=https://nodejs.org/dist ;; \
      "linux/riscv64") NODE_ARCH=riscv64; NODE_HOST=https://unofficial-builds.nodejs.org/download/release ;; \
      *) echo "Unsupported TARGETPLATFORM: $TARGETPLATFORM" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "$NODE_HOST/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" -o /tmp/node.tar.xz; \
    tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner; \
    rm /tmp/node.tar.xz; \
    corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY patches ./patches
COPY scripts ./scripts
COPY apps ./apps
COPY packages ./packages

# `--prod` skips every workspace's devDependencies, most importantly
# `wrangler → miniflare → sharp@0.34.5` at the repo root. That saves a
# whole redundant sharp/libvips prebuilt on riscv64 — where installing
# even one prebuilt through QEMU is already the slow step.
# `--ignore-scripts` bypasses the root `prepare: husky` hook whose binary
# lives in devDependencies; nothing else in the tree needs an install
# script (sharp 0.33+ ships prebuilts through optional deps).
FROM base AS server
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

ENV NODE_ENV=production
ENV PORT=8788
ENV FLOWAY_DB_PATH=/data/floway.db
ENV FLOWAY_FILES_DIR=/data/files

RUN mkdir -p /data/files

VOLUME ["/data"]
EXPOSE 8788

CMD ["pnpm", "run", "dev:node"]

# The web bundle is compiled with Vite (a devDependency), so this stage
# takes the full install and only ships the built assets forward.
FROM base AS web-build
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm run build:web

FROM nginx:1.27-alpine AS web

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80
