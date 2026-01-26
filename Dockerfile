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
