FROM node:22-slim AS builder

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy workspace root files
COPY package.json package-lock.json turbo.json tsconfig.base.json ./

# Copy package sources needed for guardian build
COPY packages/core/ packages/core/
COPY packages/erc8004-client/ packages/erc8004-client/
COPY packages/guardian/ packages/guardian/

# Create stub dirs for workspace members not needed by guardian
RUN mkdir -p packages/x402-client && echo '{"name":"@idiostasis/x402-client","version":"0.1.0"}' > packages/x402-client/package.json
RUN mkdir -p apps/reference-agent && echo '{"name":"@idiostasis/reference-agent","version":"0.1.0","private":true}' > apps/reference-agent/package.json

RUN npm ci

RUN npx turbo build --filter=@idiostasis/guardian...

# --- Runtime ---
FROM node:22-slim

RUN apt-get update && apt-get install -y libsqlite3-0 curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy built artifacts and node_modules from builder
COPY --from=builder /app/node_modules/ node_modules/
COPY --from=builder /app/packages/core/dist/ packages/core/dist/
COPY --from=builder /app/packages/core/package.json packages/core/package.json
COPY --from=builder /app/packages/erc8004-client/dist/ packages/erc8004-client/dist/
COPY --from=builder /app/packages/erc8004-client/package.json packages/erc8004-client/package.json
COPY --from=builder /app/packages/guardian/dist/ packages/guardian/dist/
COPY --from=builder /app/packages/guardian/package.json packages/guardian/package.json
COPY --from=builder /app/package.json package.json

# Copy better-sqlite3 native addon
COPY --from=builder /app/node_modules/better-sqlite3/ node_modules/better-sqlite3/
COPY --from=builder /app/node_modules/bindings/ node_modules/bindings/
COPY --from=builder /app/node_modules/file-uri-to-path/ node_modules/file-uri-to-path/
COPY --from=builder /app/node_modules/prebuild-install/ node_modules/prebuild-install/

ENV NODE_ENV=production

RUN mkdir -p /data

EXPOSE 3000

CMD ["node", "packages/guardian/dist/run.js"]
