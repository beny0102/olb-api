# syntax=docker/dockerfile:1

# Build context is the parent directory of this repository (~/work/olb), because
# @olb/contract is consumed as a file: dependency.
FROM node:24-alpine AS build
WORKDIR /app

COPY olb-contract ./olb-contract
COPY olb-api/package.json olb-api/package-lock.json ./olb-api/
RUN npm ci --prefix olb-api

COPY olb-api/tsconfig.json olb-api/tsconfig.build.json ./olb-api/
COPY olb-api/src ./olb-api/src
RUN npm run build --prefix olb-api

FROM node:24-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3001
WORKDIR /app

# @olb/contract is linked as a file: dependency, and npm does not install the
# linked package's own dependencies. Install them where Node will resolve them.
COPY olb-contract/package.json olb-contract/package-lock.json ./olb-contract/
RUN npm ci --prefix olb-contract --omit=dev

COPY olb-api/package.json olb-api/package-lock.json ./olb-api/
RUN npm ci --prefix olb-api --omit=dev

COPY olb-contract ./olb-contract
RUN npm cache clean --force

COPY --from=build /app/olb-api/dist ./olb-api/dist

WORKDIR /app/olb-api
USER node
EXPOSE 3001

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3001/health >/dev/null || exit 1

CMD ["node", "dist/main.js"]
