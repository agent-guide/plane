# url-mcp 镜像（链接读取 MCP，:8624）——多阶段：容器内构建 → node 运行时。
# 对齐部署架构（服务器 git 拉代码、服务器构建，deploy-aliyun.sh §六）。
#   podman build -f services/url-mcp/Dockerfile -t plane-url-mcp:vN .
FROM node:20-alpine AS build
WORKDIR /src
# --registry 参数式指定国内源。勿用 npm config set：构建环境 HOME 不可写，
# 该命令静默失败断链——2026-11-28 交互诊断实证（容器内 npm 本身 2s 装完）
COPY package.json package-lock.json* ./
RUN npm install --registry=https://registry.npmmirror.com --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /svc
ENV NODE_ENV=production PORT=8624
COPY --from=build /src/dist ./dist
COPY package.json ./
EXPOSE 8624
CMD ["node", "dist/index.mjs"]
