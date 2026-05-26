# Stage 1: Build env
FROM node:20-alpine AS builder

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci --only=production

# Stage 2: Production env
FROM node:20-alpine

# Set production environment variables
ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=192"

WORKDIR /usr/src/app

# Copy production node_modules from builder
COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY . .

# Run the bot directly to bypass npm process memory overhead
CMD ["node", "src/index.js"]
