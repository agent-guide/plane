# plane-web 镜像 —— React Router 静态 SPA，多阶段：node 构建 → nginx 运行时。
# 设计 docs/v2/aliyun-plane-stack-deploy-plan.md §四。
# 构建上下文必须是仓库根（web 按 dist 消费 packages/*，turbo 拓扑先建）：
#   podman build -f apps/web/Dockerfile \
#     --build-arg PUBLIC_BASE_URL=http://8.130.36.59:19100 \
#     -t plane-web:vN .
FROM node:22-slim AS build

WORKDIR /repo
# 依赖层（先装后拷源，缓存命中）
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY packages ./packages
COPY apps/web/package.json ./apps/web/
RUN corepack enable && pnpm install --frozen-lockfile

# 源码层 + 构建（packages/* 先 turbo build——web 按 dist 消费 @plane/*，
# 旧 dist 致功能丢失为测试服 11-21 实证）
COPY apps/web ./apps/web
RUN npx turbo run build --filter='@plane/*'

# 公网地址构建期烧入（dual-deploy-plan §3.2）：同源相对路径 + 公网入口。
# VITE 五地址与 deploy-v2.sh L35-41 一致；空值键保持空串
ARG PUBLIC_BASE_URL
RUN cd apps/web && \
    VITE_API_BASE_URL="" \
    VITE_WEB_BASE_URL="$PUBLIC_BASE_URL" \
    VITE_ADMIN_BASE_URL="$PUBLIC_BASE_URL" \
    VITE_SPACE_BASE_URL="$PUBLIC_BASE_URL" \
    VITE_LIVE_BASE_URL="$PUBLIC_BASE_URL" \
    VITE_RUNTIME_CONSOLE_BASE_URL="" \
    VITE_EXPERTS_API_BASE_URL="" \
    npx react-router build
# localhost 残留校验（fail-closed，deploy-v2.sh L44 同款）
RUN if grep -rl "localhost:8001" apps/web/build/client/assets/*.js; then \
        echo "FAIL: 前端产物残留 localhost:8001 直连地址"; exit 1; \
    fi

# ── 运行时：nginx 静态托管 + 同源反代 ──────────────────────────────
FROM nginx:1.27-alpine
COPY apps/web/nginx.container.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/build/client /usr/share/nginx/html
EXPOSE 80
