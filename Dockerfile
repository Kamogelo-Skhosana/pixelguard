# syntax=docker/dockerfile:1
#
# pixelguard: the CLI (capture, diff, accept, baseline) and the dashboard,
# with Chromium for Playwright. Ticket: P046
#
#   docker build -t pixelguard .
#   docker run --rm -p 127.0.0.1:8100:8100 --env-file .env -v "$PWD/pixelguard-data:/data" pixelguard
#
# Everything the app writes (screenshots, diffs, the SQLite database) goes to
# /data, the working directory. Mount a folder or volume there to keep it.

ARG NODE_VERSION=20

# ---- Build: compile TypeScript and install production dependencies ----
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app

# Build tools, only used if better-sqlite3 has no prebuilt binary for this platform.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
# Chromium is installed in the runtime stage, matching the playwright version from the lockfile.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev && npm cache clean --force

# ---- Runtime ----
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    # Listen on all interfaces inside the container; the port mapping decides who can reach it.
    DASHBOARD_HOST=0.0.0.0 \
    DASHBOARD_PORT=8100 \
    OUTPUT_DIR=/data/screenshots \
    DIFF_DIR=/data/diffs \
    DATABASE_URL=sqlite:/data/pixelguard.db

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY public ./public

# Chromium plus the system libraries it needs, using the project's own
# playwright version so the browser always matches the library.
RUN node node_modules/playwright/cli.js install --with-deps chromium \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data \
  && chown node:node /data

# Run as the image's unprivileged "node" user (uid 1000).
USER node
WORKDIR /data
VOLUME ["/data"]
EXPOSE 8100

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.DASHBOARD_PORT || 8100) + '/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["dashboard"]
