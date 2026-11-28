# platform-tools-mcp 镜像（平台内置工具链）。
# 同 url-mcp 模式：构建产物 dist/index.mjs 入库（本机构建、服务器零构建零 npm）；
# 运行时零外部依赖（仅 devDeps，--packages-external 产物自包含）。
# 更新产物：本目录 npm install && npm run build && git add dist/
#   podman build -f services/platform-tools-mcp/Dockerfile -t plane-platform-tools:vN .
FROM node:20-alpine
WORKDIR /svc
ENV NODE_ENV=production
COPY services/platform-tools-mcp/dist ./dist
COPY services/platform-tools-mcp/package.json ./
CMD ["node", "dist/index.mjs"]
