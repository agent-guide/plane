# platform-tools-mcp 镜像（平台内置工具链）——多阶段：容器内构建 → node 运行时。
# ⚠️ 同 url-mcp：上下文是仓库根，COPY 必须带 services/platform-tools-mcp/ 前缀
# （裸 package.json 会拷到根 monorepo 清单——catalog: 报错真凶）。
#   podman build -f services/platform-tools-mcp/Dockerfile -t plane-platform-tools:vN .
FROM node:20-alpine AS build
WORKDIR /src
COPY services/platform-tools-mcp/package.json services/platform-tools-mcp/package-lock.json* ./
RUN npm install --registry=https://registry.npmmirror.com --no-audit --no-fund
COPY services/platform-tools-mcp/ ./
RUN npm run build

FROM node:20-alpine
WORKDIR /svc
ENV NODE_ENV=production
COPY --from=build /src/dist ./dist
COPY services/platform-tools-mcp/package.json ./
CMD ["node", "dist/index.mjs"]
