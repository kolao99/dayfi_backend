# syntax=docker/dockerfile:1
# Production API: migrations then Node (see package.json start:prod).
FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts/npm-prepare-husky.cjs scripts/npm-prepare-husky.cjs
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV SWITCH_NODE_ENV=production
ENV DAYFI_NODE_ENV=production

COPY package.json package-lock.json ./
# prepare runs before full COPY; husky helper must exist for npm ci --omit=dev
COPY scripts/npm-prepare-husky.cjs scripts/npm-prepare-husky.cjs
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/migrations ./migrations
COPY --from=builder /app/database.json ./
COPY --from=builder /app/scripts ./scripts

RUN chown -R node:node /app
USER node
EXPOSE 3000
CMD ["npm", "run", "start:prod"]
