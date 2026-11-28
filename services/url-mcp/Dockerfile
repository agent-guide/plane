# url-mcp 镜像（链接读取 MCP，:8624）。
# esbuild 单文件产物 + node 运行时（deploy-v2.sh 同款：服务器零构建零 npm）。
#   podman build -f services/url-mcp/Dockerfile -t plane-url-mcp:vN .
FROM node:20-alpine AS build
WORKDIR /src
COPY package.json package-lock.json* ./
RUN npm ci --silent || npm install --silent
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /svc
ENV NODE_ENV=production PORT=8624
COPY --from=build /src/dist ./dist
COPY package.json ./
EXPOSE 8624
CMD ["node", "dist/index.mjs"]
