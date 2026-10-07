FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY . .
RUN npm ci && npm run build && npm prune --omit=dev

FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS runtime
ENV NODE_ENV=production PORT=4100 HOST=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/api ./apps/api
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=node:node /app/packages ./packages
RUN mkdir -p /recordings/raw /recordings/encrypted && chown -R node:node /recordings && chmod 700 /recordings /recordings/raw /recordings/encrypted
USER node
EXPOSE 4100
CMD ["node", "apps/api/dist/index.js"]
