# syntax=docker/dockerfile:1

# ---- Dependencies (production only) ----
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# allowScripts approvals are pinned in package.json (bcrypt, sqlite3).
RUN npm ci --omit=dev --no-audit --no-fund

# ---- Runtime ----
FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Native modules (bcrypt/sqlite3) ship prebuilt NAPI binaries; no build tools needed.
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Persistent data dir for SQLite (mount a volume here in production).
RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV PORT=3000
ENV DB_DIALECT=sqlite
ENV DB_STORAGE=/app/data/timeoff.sqlite
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "bin/wwww"]
