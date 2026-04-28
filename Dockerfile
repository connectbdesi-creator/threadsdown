FROM node:20-slim

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Copy app source
COPY server ./server
COPY public ./public

# Run as the non-root "node" user shipped in the base image
RUN mkdir -p /app/logs && chown -R node:node /app
USER node

EXPOSE 3000

CMD ["node", "server/index.js"]
