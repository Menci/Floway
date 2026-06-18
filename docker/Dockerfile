# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS base
WORKDIR /app

ENV HUSKY=0
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY patches ./patches
COPY scripts ./scripts
COPY apps ./apps
COPY packages ./packages

RUN pnpm install --frozen-lockfile

FROM base AS server

ENV NODE_ENV=production
ENV PORT=8788
ENV FLOWAY_DB_PATH=/data/floway.db
ENV FLOWAY_FILES_DIR=/data/files

RUN mkdir -p /data/files

VOLUME ["/data"]
EXPOSE 8788

CMD ["pnpm", "run", "dev:node"]

FROM base AS web-build

RUN pnpm run build:web

FROM nginx:1.27-alpine AS web

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80
