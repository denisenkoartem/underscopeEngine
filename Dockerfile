# syntax=docker/dockerfile:1
# Underscope in one image:
#   - the demo page (public/) and the Vercel functions in api/*.ts, served by scripts/dev-server.ts on $PORT
#   - the Python function api/route.py (the engine in engine/src), served by scripts/py-api.py behind it
# Keys come from the environment at run time (--env-file .env); nothing secret is copied into the image.

FROM node:22-bookworm-slim AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Python deps for api/route.py: the same list Vercel installs.
FROM base AS py-deps
COPY requirements.txt ./
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt

# Node deps: npm, from package-lock.json.
FROM base AS web-deps
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM base
ENV PATH=/opt/venv/bin:/app/node_modules/.bin:$PATH \
    PORT=3000 \
    PY_API_PORT=3001 \
    PY_API_URL=http://127.0.0.1:3001
COPY --from=py-deps /opt/venv /opt/venv
COPY --from=web-deps /app/node_modules node_modules
COPY . .
USER node
EXPOSE 3000
ENTRYPOINT ["tini", "-g", "--"]
CMD ["sh", "scripts/docker-start.sh"]
