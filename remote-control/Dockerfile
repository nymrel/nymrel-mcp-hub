FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    NYMREL_REMOTE_HOST=0.0.0.0 \
    NYMREL_REMOTE_PORT=8787 \
    NYMREL_REMOTE_STORE=/data/state.json \
    NYMREL_REMOTE_CONTAINER_WRITABLE_ROOT=/data \
    NYMREL_REMOTE_OIDC_ISSUER_ENABLED=false
COPY package.json package-lock.json ./
COPY bin ./bin
COPY src ./src
COPY public ./public
COPY oidc-issuer/package.json oidc-issuer/package-lock.json ./oidc-issuer/
RUN npm ci --prefix oidc-issuer --omit=dev --ignore-scripts
COPY oidc-issuer/src ./oidc-issuer/src
COPY README.md SECURITY.md ./
RUN mkdir -p /data && chown -R node:node /app /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:8787/readyz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["node", "./bin/nymrel-remote-container-entrypoint.js"]
