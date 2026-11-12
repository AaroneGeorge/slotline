# syntax=docker/dockerfile:1
# Slotline: Next.js 16 + better-sqlite3 (13.x installs with `node-gyp rebuild`, so the deps stage needs python3/make/g++).
FROM node:24-bookworm-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

FROM base AS deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
# NEXT_PUBLIC_* values are inlined at build time; the PayPal client id is also served at runtime by /api/config/public.
ARG NEXT_PUBLIC_PAYPAL_CLIENT_ID=""
ARG NEXT_PUBLIC_PAYPAL_CURRENCY="USD"
ENV NEXT_PUBLIC_PAYPAL_CLIENT_ID=$NEXT_PUBLIC_PAYPAL_CLIENT_ID \
    NEXT_PUBLIC_PAYPAL_CURRENCY=$NEXT_PUBLIC_PAYPAL_CURRENCY
RUN pnpm build

FROM base AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/app/data/slotline.db
COPY --from=build /app/package.json /app/next.config.ts ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/config/public').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node_modules/.bin/next", "start", "-H", "0.0.0.0", "-p", "3000"]
