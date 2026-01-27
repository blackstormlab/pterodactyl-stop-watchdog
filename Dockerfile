FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY watchdog.js .

ENV NODE_ENV=production
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "watchdog.js"]

LABEL org.opencontainers.image.source=https://github.com/blackstormlab/pterodactyl-stop-watchdog
LABEL org.opencontainers.image.description="A small Docker-based watchdog that automatically force-kills Pterodactyl servers if they fail to stop gracefully after a configurable timeout. This is useful for game servers that occasionally hang on shutdown and block restarts, updates, or node reboots."
LABEL org.opencontainers.image.licenses=MIT