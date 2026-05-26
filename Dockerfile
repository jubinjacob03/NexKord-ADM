# Stage 1: Build env
FROM node:20-alpine AS builder

WORKDIR /usr/src/app

# Install only production dependencies
COPY package*.json ./
RUN npm ci --only=production

# Stage 2: Production env
FROM node:20-alpine

WORKDIR /usr/src/app

# Copy production node_modules from builder
COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY . .

# Run the bot
CMD ["npm", "start"]
