FROM node:24.22.1-trixie-slim@sha256:89c5244bc22a9bc3287d89ebc7e49b9cb5bb84cd40e6175ac3421d5a9f68b95a AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY . .
RUN npm ci && npm run build && npm prune --omit=dev

FROM node:24.22.1-trixie-slim@sha256:89c5244bc22a9bc3287d89ebc7e49b9cb5bb84cd40e6175ac3421d5a9f68b95a AS runtime-base
ENV NODE_ENV=production PORT=4100 HOST=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/api ./apps/api
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=node:node /app/packages ./packages
RUN mkdir -p /recordings/raw /recordings/encrypted && chown -R node:node /recordings && chmod 700 /recordings /recordings/raw /recordings/encrypted
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v1.22.22 \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
USER node
EXPOSE 4100
CMD ["node", "apps/api/dist/index.js"]

FROM runtime-base AS media-generation-test
COPY --from=build --chown=node:node /app/apps/phone ./apps/phone

FROM runtime-base AS runtime
