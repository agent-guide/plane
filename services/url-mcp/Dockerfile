# url-mcp 镜像（链接读取 MCP，:8624）——多阶段：容器内构建 → node 运行时。
# ⚠️ 构建上下文是仓库根：COPY 必须写全 services/url-mcp/ 前缀——裸写
# package.json 会拷到仓库根的 monorepo 清单（pnpm catalog: 协议，npm 报
# EUNSUPPORTEDPROTOCOL——2026-11-28 排障半日的真凶）。
#   podman build -f services/url-mcp/Dockerfile -t plane-url-mcp:vN .
FROM node:20-alpine AS build
WORKDIR /src
COPY services/url-mcp/package.json services/url-mcp/package-lock.json* ./
RUN npm install --registry=https://registry.npmmirror.com --no-audit --no-fund
COPY services/url-mcp/ ./
RUN npm run build

FROM node:20-alpine
WORKDIR /svc
ENV NODE_ENV=production PORT=8624
COPY --from=build /src/dist ./dist
COPY services/url-mcp/package.json ./
EXPOSE 8624
CMD ["node", "dist/index.mjs"]
