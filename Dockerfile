# Klatsch relay. Node 26 runs the TypeScript sources directly: no build step, no dev dependencies.
# Base pinned by digest (node:26.13.0-trixie-slim, multi-arch index); bump both together.
ARG NODE_IMAGE=node:26.13.0-trixie-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    KLATSCH_HOST=0.0.0.0 \
    KLATSCH_PORT=7417 \
    KLATSCH_DATA_DIR=/data
WORKDIR /app
# The relay needs only node: no package manager in the running image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
# `klatsch` on PATH, for `docker compose exec klatsch klatsch login --user ...`.
RUN printf '#!/bin/sh\nexec node /app/src/cli.ts "$@"\n' > /usr/local/bin/klatsch \
 && chmod 0755 /usr/local/bin/klatsch \
 && mkdir -p /data && chown node:node /data && chmod 0700 /data
# The data dir (SQLite database, WAL, server secret) is the only place the relay writes:
# the root file system can be mounted read-only.
VOLUME ["/data"]
USER node
EXPOSE 7417
# Hosted, the relay answers only on its public host name (DNS rebinding protection), so ask with that Host.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "const u=new URL(process.env.KLATSCH_PUBLIC_URL);require('node:http').get({host:'127.0.0.1',port:process.env.KLATSCH_PORT,path:'/',headers:{host:u.host}},(r)=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1)).setTimeout(4000,()=>process.exit(1))"]
CMD ["node", "/app/src/cli.ts", "up"]
