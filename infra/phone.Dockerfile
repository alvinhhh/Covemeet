FROM node:24.21.0-bookworm-slim AS build
WORKDIR /app
COPY . .
RUN npm ci && npm run build -w apps/phone && npm prune --omit=dev

FROM node:24.21.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/phone ./apps/phone
USER node
CMD ["node", "apps/phone/dist/serve.js"]
