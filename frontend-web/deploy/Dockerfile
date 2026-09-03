FROM node:22-alpine AS web-build

WORKDIR /src/frontend-web
COPY frontend-web/package.json frontend-web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend-web/ ./
RUN npm run build

FROM python:3.12-slim AS runtime

ARG DEBIAN_MIRROR=deb.debian.org
ARG PYPI_INDEX_URL=https://pypi.org/simple

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HOME=/root \
    RIND_HOME=/root/.rind

WORKDIR /app
COPY requirements-runtime.txt ./
RUN sed -i "s|deb.debian.org|$DEBIAN_MIRROR|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates git bash \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir --index-url "$PYPI_INDEX_URL" -r requirements-runtime.txt
COPY agent/ ./agent/
COPY main.py ./
COPY frontend-web/deploy/healthcheck.py ./deploy/healthcheck.py

EXPOSE 8765
ENTRYPOINT ["python", "main.py"]

FROM nginx:1.27-alpine AS web
COPY --from=web-build /src/frontend-web/dist/ /usr/share/nginx/html/
COPY frontend-web/deploy/nginx.conf /etc/nginx/conf.d/default.conf
