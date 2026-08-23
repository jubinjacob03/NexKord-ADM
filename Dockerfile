FROM node:22-alpine AS builder

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install --omit=dev

FROM node:22-alpine

RUN apk add --no-cache \
    ca-certificates \
    gcompat \
    libstdc++

ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=256 --expose-gc"

WORKDIR /usr/src/app

COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY . .

CMD ["sh", "-c", "node src/deploy-commands.js && node src/index.js"]
