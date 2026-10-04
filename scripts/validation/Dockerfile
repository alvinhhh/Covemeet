FROM node:22-bookworm-slim
WORKDIR /validation
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY media-controls.mjs ./
USER node
CMD ["node", "media-controls.mjs"]
