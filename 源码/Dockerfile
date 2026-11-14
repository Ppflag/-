# 构建机访问 Docker Hub 不稳定，用国内镜像源（2026-10-20 实测：官方源 16 秒即失败）
FROM docker.m.daocloud.io/library/node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
COPY server.js ./
COPY auth.js ./
COPY public ./public

EXPOSE 3000

CMD ["node", "server.js"]