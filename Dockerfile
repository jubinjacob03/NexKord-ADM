# Stage 1: Build env
FROM node:20-alpine AS builder

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci --only=production

# Stage 2: Production env
FROM node:20-alpine

# Install Chromium and dependencies for Puppeteer
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Set production environment variables
ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=384"

WORKDIR /usr/src/app

# Copy production node_modules from builder
COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY . .

# Run the bot directly to bypass npm process memory overhead
CMD ["sh", "-c", "node src/deploy-commands.js && node src/index.js"]
