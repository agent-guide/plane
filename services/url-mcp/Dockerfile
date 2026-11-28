# url-mcp 镜像（链接读取 MCP，:8624）。
# 构建产物 dist/index.mjs 已入库（deploy-v2 同款模式：本机构建、服务器零构建
# 零 npm——2026-11-28 实证：容器内 npm 装依赖在该网络环境不稳，产物入库一劳永逸）。
# 运行时零外部依赖（package.json 仅 devDeps，--packages-external 产物自包含）。
# 更新产物：本目录 npm install && npm run build && git add dist/
#   podman build -f services/url-mcp/Dockerfile -t plane-url-mcp:vN .
FROM node:20-alpine
WORKDIR /svc
ENV NODE_ENV=production PORT=8624
COPY services/url-mcp/dist ./dist
COPY services/url-mcp/package.json ./
EXPOSE 8624
CMD ["node", "dist/index.mjs"]
