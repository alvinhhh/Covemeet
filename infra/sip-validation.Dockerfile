FROM covemeet-sip-client:local AS sip-client
FROM node:24.21.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libsrtp2-1 libssl3 && rm -rf /var/lib/apt/lists/*
COPY --from=sip-client /usr/local/bin/covemeet-sip-client /usr/local/bin/covemeet-sip-client
WORKDIR /app
COPY . .
RUN npm ci && npm run build
USER node
CMD ["node", "scripts/validation/sip-media.mjs"]
