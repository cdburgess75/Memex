FROM node:20-alpine
WORKDIR /app
COPY server/package*.json ./server/
RUN cd server && npm ci --production
COPY . .
EXPOSE 3000
CMD ["node", "server/index.js"]
