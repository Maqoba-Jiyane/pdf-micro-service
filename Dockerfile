# Playwright base has Chromium + fonts + deps
FROM mcr.microsoft.com/playwright:v1.47.2-jammy

WORKDIR /app

# Install only production deps
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy app
COPY server.js ./

EXPOSE 3001
ENV NODE_ENV=production

CMD ["node", "server.js"]
