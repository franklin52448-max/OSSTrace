# Production image for @osstrace/server (packages/server) -- a real always-on Fastify process
# (session DB, background alert-polling worker), not a serverless function. Runs TypeScript
# directly via Node's built-in type stripping, same as dev (packages/server has no separate
# build step: its package.json's "main"/dev/start scripts all run src/main.ts directly), and
# uses Node's built-in node:sqlite, so no native-module compilation is needed here.
#
# The whole workspace is installed (not just packages/server + packages/contract) because
# `npm ci` resolves the root package-lock.json's full workspace graph; narrower pruning is a
# worthwhile later optimization, not done here under time pressure.
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages ./packages
COPY scripts ./scripts

RUN npm ci --omit=optional

WORKDIR /app/packages/server

ENV NODE_ENV=production
EXPOSE 5320

CMD ["node", "--experimental-strip-types", "src/main.ts"]
