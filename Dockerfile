FROM node:22.23.2-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS dependencies

ENV PUPPETEER_SKIP_DOWNLOAD=true

WORKDIR /usr/src/app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22.23.2-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32

RUN apk add --no-cache \
    ca-certificates \
    gcompat \
    libstdc++

ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=1024"

WORKDIR /usr/src/app

COPY --from=dependencies --chown=node:node /usr/src/app/node_modules ./node_modules
COPY --chown=node:node . .
RUN mkdir -p data logs && chown -R node:node data logs

USER node

CMD ["node", "src/index.js"]
