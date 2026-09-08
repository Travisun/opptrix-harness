# =============================================================================
# docker/Dockerfile — Opptrix Harness OS 生产镜像（多阶段）
#
# 构建上下文必须是仓库根（.dockerignore 已排除 node_modules/dist/test/data 等）：
#   docker build -t opptrix-harness:latest -f docker/Dockerfile .
# 运行（.env 见仓库根 .env.example）：
#   docker run -p 3000:3000 -v opptrix-data:/data --env-file .env opptrix-harness:latest
# =============================================================================

# ---------- 阶段 1：构建（含 devDependencies，tsc 编译） ----------
FROM node:24-alpine AS build

WORKDIR /app

# better-sqlite3 在 musl 无预编译产物时需本地编译（兜底工具链）
RUN apk add --no-cache python3 make g++

# 先只拷贝依赖清单再 npm ci，充分利用层缓存
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---------- 阶段 1b：webui UI 构建（builtin 扩展 webui 的管理台产物） ----------
# 注意：根 .dockerignore 当前排除 `extensions/*/ui-src`（构建上下文不含 Vite 源码），
# 而 SPA 产物 extensions/webui/ui/ 随仓库提交（.gitignore 白名单 !extensions/webui/ui/）。
# 因此本阶段当前从产物直通（保证 docker build 可用）；待 .dockerignore 放行
# `!extensions/webui/ui-src` 后，可切换为源码构建（等价命令见下方注释）。
FROM node:24-alpine AS ui-build

WORKDIR /app

# 产物直通：ui-build 阶段持有与仓库一致的 extensions/webui/ui/
COPY extensions/webui/ui/ ./extensions/webui/ui/

# 源码构建变体（.dockerignore 放行 ui-src 后启用，替换上面两行）：
#   COPY extensions/webui/ui-src/package.json extensions/webui/ui-src/package-lock.json ./extensions/webui/ui-src/
#   RUN cd extensions/webui/ui-src && npm ci
#   COPY extensions/webui/ui-src/ ./extensions/webui/ui-src/
#   RUN cd extensions/webui/ui-src && npm run build   # vite outDir '../ui' → /app/extensions/webui/ui

# ---------- 阶段 2：运行（非 root，数据卷 /data） ----------
FROM node:24-alpine

# 兜底重建 better-sqlite3 原生模块所需工具链（正常路径直接用 build 阶段产物，
# 仅当基础镜像变体/平台不一致需要 rebuild 时才触发）
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/bootstrap.mjs ./bootstrap.mjs
COPY --from=build /app/types ./types

# webui 内置扩展（builtin:true）：manifest + 入口（build 阶段上下文携带）+
# 管理台 SPA 产物（ui-build 阶段）。扩展发现扫描 <repo>/extensions/，缺 manifest/main
# 则 webui 不会被启用，ui/ 产物也不会被静态挂载。
# （注：其余 extensions/（auth 等）当前镜像未携带——既有部署缺口，归属内核发布工程。）
COPY --from=build /app/extensions/webui/index.js /app/extensions/webui/manifest.json ./extensions/webui/
COPY --from=ui-build /app/extensions/webui/ui ./extensions/webui/ui
COPY extensions/auth ./extensions/auth
COPY extensions/hello-world ./extensions/hello-world
COPY extensions/echo-bot ./extensions/echo-bot
COPY extensions/doc-demo ./extensions/doc-demo

ENV NODE_ENV=production \
    HARNESS_DATA_DIR=/data \
    HARNESS_PORT=3000 \
    HARNESS_HOST=0.0.0.0

# /data 为数据卷（SQLite/uploads/extensions/backups）；运行时以非 root 身份读写
RUN mkdir -p /data && chown -R node:node /data /app

USER node
EXPOSE 3000
VOLUME /data

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

# bootstrap.mjs（仓库根启动器）读取 <dataDir>/releases/slots.json 启动 slot 内 dist/main.js
ENTRYPOINT ["node", "bootstrap.mjs"]
