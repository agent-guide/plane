# platform-tools-mcp 镜像（平台内置工具链）。
# 同 url-mcp 形态：esbuild 单文件产物 + node20 运行时。
#   podman build -f services/platform-tools-mcp/Dockerfile -t plane-platform-tools:vN .
FROM node:20-alpine AS build
WORKDIR /src
# npm 走国内镜像源（境外 registry 在构建网络下不稳）
COPY package.json package-lock.json* ./
RUN npm config set registry https://registry.npmmirror.com \
    && (npm ci --silent || npm install --silent)
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /svc
ENV NODE_ENV=production
COPY --from=build /src/dist ./dist
COPY package.json ./
CMD ["node", "dist/index.mjs"]
