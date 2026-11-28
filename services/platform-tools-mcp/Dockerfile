# platform-tools-mcp 镜像（平台内置工具链）——多阶段：容器内构建 → node 运行时。
# 对齐部署架构（服务器构建）；npm 国内源用 --registry 参数式（勿 config set，
# 构建环境 HOME 不可写会静默失败——2026-11-28 实证）。
#   podman build -f services/platform-tools-mcp/Dockerfile -t plane-platform-tools:vN .
FROM node:20-alpine AS build
WORKDIR /src
COPY package.json package-lock.json* ./
RUN npm install --registry=https://registry.npmmirror.com --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /svc
ENV NODE_ENV=production
COPY --from=build /src/dist ./dist
COPY package.json ./
CMD ["node", "dist/index.mjs"]
