# ---------- build stage ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NODE_ENV=development
# build toolchain so native modules (better-sqlite3, sharp) can compile if no prebuilt binary is available
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build -w web && npm run build -w server
# prune dev deps for the runtime image
RUN npm prune --omit=dev --no-audit --no-fund

# ---------- runtime stage ----------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data
# ffmpeg for frame extraction + audio; tini for clean signal handling
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/harvester ./harvester
# Runs as root so a Railway/Docker volume mounted at /data is always writable (single-user app).
RUN mkdir -p /data
EXPOSE 8080
# (No Docker VOLUME directive on purpose: Railway rejects it — mount a Railway Volume at /data instead.)
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/dist/index.js"]
