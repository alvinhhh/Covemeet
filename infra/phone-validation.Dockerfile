FROM node:24.21.0-bookworm-slim
WORKDIR /app
COPY . .
RUN npm ci && npm run build
USER node
CMD ["node", "scripts/validation/phone-suite.mjs"]
