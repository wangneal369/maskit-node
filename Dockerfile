# syntax=docker/dockerfile:1
# ==========================================
# Data Maskit 无头部署镜像（无 Electron）：网关 + 浏览器扩展桥接 + Web 控制面板
# 构建：docker build -t maskit-node .
# ==========================================

# ---------- 阶段 1：构建（前端 + 服务端 bundle）----------
# 产物是平台无关的 JS，固定在构建机原生架构上跑，避免多架构构建时被 QEMU 拖慢
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS builder
WORKDIR /build

# 构建只需要 esbuild / typescript / vite，不需要 Electron 二进制与各类 postinstall
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    npm_config_audit=false \
    npm_config_fund=false

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY frontend/package.json frontend/package-lock.json frontend/
RUN npm ci --ignore-scripts --prefix frontend

COPY . .
# 前端 -> public/dist；服务端 -> dist-server/main.cjs
RUN npm run build --prefix frontend \
    && mkdir -p public/dist \
    && cp -r frontend/dist/. public/dist/ \
    && node scripts/build-server.mjs

# ---------- 阶段 2：运行时 ----------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# onnxruntime-node 的 install 脚本在 linux/x64 上会额外下载 CUDA/TensorRT 执行器（数百 MB）；NER 只用 CPU，
# CPU 库随 npm 包自带，跳过下载可显著缩小镜像（对 arm64 本就无此下载，行为一致）
ENV ONNXRUNTIME_NODE_INSTALL=skip

# 仅 NER（本地语义实体识别）需要原生依赖 onnxruntime-node：版本取自 lockfile，
# 其余依赖都已打进 dist-server/main.cjs。在目标架构上安装，才能拿到对应的预编译二进制。
COPY package.json package-lock.json /tmp/pkg/
RUN set -eux; \
    ONNX_VER="$(node -p "require('/tmp/pkg/package-lock.json').packages['node_modules/onnxruntime-node'].version")"; \
    npm install --prefix /app --no-save --no-package-lock --omit=dev --no-audit --no-fund "onnxruntime-node@${ONNX_VER}"; \
    rm -rf /tmp/pkg /root/.npm

COPY --from=builder /build/dist-server ./dist-server
COPY --from=builder /build/public/dist ./public/dist
COPY --from=builder /build/agent-bundle ./agent-bundle
# 版本号来源（GatewayCore 的 version）
COPY --from=builder /build/package.json ./package.json

# 非 root（node 镜像自带 uid 1000 的 node 用户）；/data 为配置、SQLite、面板令牌、NER 模型的持久化目录
RUN mkdir -p /data && chown node:node /data
USER node

# 监听 0.0.0.0 才能被容器外访问；网关端口没有鉴权，务必只暴露在可信网络 / 前置鉴权（见 README「Docker 部署」）
ENV NODE_ENV=production \
    MASKIT_DATA_DIR=/data \
    MASKIT_PANEL_HOST=0.0.0.0 \
    MASKIT_PANEL_PORT=18700 \
    MASKIT_LISTEN_HOST=0.0.0.0 \
    MASKIT_WEB_DIST=/app/public/dist \
    MASKIT_BUNDLE_DIR=/app/agent-bundle

VOLUME ["/data"]

# 18700 控制面板 / 18701-18703 默认三个上游网关端口 / 5801 浏览器扩展桥接
# 若在面板里新增了其它上游端口，需要同步增加 -p 映射
EXPOSE 18700 18701 18702 18703 5801

# /healthz 免令牌，只回存活状态（镜像里没有 curl，用 node 自带的 fetch）
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.MASKIT_PANEL_PORT||18700)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "--disable-warning=ExperimentalWarning", "dist-server/main.cjs"]
