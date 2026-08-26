# syntax=docker/dockerfile:1

# ============ Stage 1: build ============
# Needs the full dependency tree (TypeScript, Prisma CLI) to compile and
# generate the Prisma client — none of this ships in the final image.
FROM node:20-bookworm-slim AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY prisma ./prisma
COPY tsconfig.json ./
COPY src ./src

RUN npx prisma generate
RUN npm run build

# ============ Stage 2: production ============
FROM node:20-bookworm-slim AS production
ENV NODE_ENV=production
WORKDIR /app

# python3 + pip for the Catalog Extractor's Python bridge (src/utils/pythonRunner.ts
# shells out to python/extract.py). PyMuPDF and friends come from requirements.txt.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

# Bring over the compiled app and the Prisma client generated in the builder
# stage (the builder had the full toolchain to generate it; the prod
# npm ci above intentionally does not).
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY prisma ./prisma

COPY python ./python
RUN pip3 install --break-system-packages --no-cache-dir -r python/requirements.txt

COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh \
    && mkdir -p uploads/catalogs uploads/extracted-images uploads/reference-images uploads/print-boards logs

EXPOSE 5000

# Same check Docker/Compose/an orchestrator uses to decide if this
# container is healthy — hits the real /health endpoint, which itself
# verifies the database connection, not just "the process is running."
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://localhost:5000/api/v1/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
