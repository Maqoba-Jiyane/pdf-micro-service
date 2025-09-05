# Dockerfile
ARG PW_VER=1.55.0
FROM mcr.microsoft.com/playwright:v${PW_VER}-jammy

WORKDIR /app

# copy manifests first
COPY package.json package-lock.json ./

# install deps
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts

# copy app
COPY server.js ./

EXPOSE 3001
ENV NODE_ENV=production
CMD ["node", "server.js"]
