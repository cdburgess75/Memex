FROM node:20-alpine

LABEL org.opencontainers.image.source="https://github.com/cdburgess75/Memex"
LABEL org.opencontainers.image.description="Memex — team knowledge base kept by Claude"
LABEL org.opencontainers.image.licenses="MIT"

WORKDIR /app

# Install production dependencies before copying source so this layer is cached
COPY server/package*.json ./server/
RUN cd server && npm ci --production && npm cache clean --force

# Copy application source
COPY . .

# Run as a non-root user. Pre-create the storage dir owned by memex so a fresh
# named volume mounted at /data/documents inherits writable ownership.
RUN addgroup -S memex && adduser -S memex -G memex && \
    mkdir -p /data/documents && \
    chown -R memex:memex /app /data
USER memex

EXPOSE 3000
CMD ["node", "server/index.js"]
