FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src

ENV MCP_TRANSPORT=http \
    HOST=0.0.0.0 \
    PORT=3000

EXPOSE 3000

RUN mkdir -p /data/batches && chown -R node:node /data

USER node

CMD ["node", "src/server.mjs"]
