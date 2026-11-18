FROM node:22-alpine AS web-build

WORKDIR /src/frontend-web
COPY frontend-web/package.json frontend-web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY runtime/src/protocol/ /src/runtime/src/protocol/
COPY frontend-web/ ./
RUN npm run build

FROM node:22-alpine AS runtime-build

WORKDIR /src/runtime
COPY runtime/package*.json ./
RUN npm ci --no-audit --no-fund
COPY runtime/ ./
RUN npm run build && npm prune --omit=dev

FROM node:22-slim AS runtime

ARG DEBIAN_MIRROR=deb.debian.org

ENV HOME=/root \
    RIND_HOME=/root/.rind

WORKDIR /app
RUN sed -i "s|deb.debian.org|$DEBIAN_MIRROR|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates git bash ripgrep \
    && rm -rf /var/lib/apt/lists/*
COPY --from=runtime-build /src/runtime/dist ./runtime/dist
COPY --from=runtime-build /src/runtime/node_modules ./runtime/node_modules
COPY runtime/skills ./runtime/skills
COPY runtime/package.json ./runtime/package.json
COPY frontend-web/deploy/healthcheck.mjs ./deploy/healthcheck.mjs

EXPOSE 8765
ENTRYPOINT ["node", "/app/runtime/dist/cli.js"]

FROM nginx:1.27-alpine AS web
COPY --from=web-build /src/frontend-web/dist/ /usr/share/nginx/html/
COPY frontend-web/deploy/nginx.conf /etc/nginx/conf.d/default.conf
