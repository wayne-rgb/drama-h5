FROM node:22.23.3-bookworm-slim AS web-build
WORKDIR /app
COPY apps/web-pc/package*.json apps/web-pc/.npmrc ./apps/web-pc/
# 本地安全补丁必须先于npm ci进入构建上下文。
COPY apps/web-pc/vendor/ ./apps/web-pc/vendor/
RUN npm --prefix apps/web-pc ci --no-audit --no-fund
COPY apps/web-pc/ ./apps/web-pc/
COPY shared/ ./shared/
RUN npm --prefix apps/web-pc run build

FROM node:22.23.3-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg util-linux && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY LICENSE ./LICENSE
COPY server/ ./server/
COPY shared/ ./shared/
COPY --from=web-build /app/apps/web-pc/dist ./apps/web-pc/dist
RUN mkdir /data && chown node:node /data
ENV HG_HOST=0.0.0.0 PORT=8788 HG_DATA_DIR=/data
EXPOSE 8788
VOLUME /data
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "server/healthcheck.mjs"]
CMD ["node", "server/index.mjs"]
