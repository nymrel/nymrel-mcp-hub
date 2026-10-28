FROM node:24-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV NYMREL_WORKSPACE_DATA_DIR=/data

COPY package.json ./
COPY src ./src
COPY bin ./bin
COPY scripts ./scripts

EXPOSE 8787

CMD ["node", "src/index.js"]
