#!/bin/bash
# plane fork 前端（web 工作台 + god-mode 管理台）生产构建脚本 —— 在 Mac 上执行
# 产物为纯静态 SPA（ssr:false），服务器无需 node；CentOS 7 glibc 2.17 无法本地构建。
# 用法：bash plane-web-mac-build.sh [服务器IP，默认 223.105.56.202]
# 完整部署流程见 experts-frontend/docs/v2/test-server-deploy-runbook.md §2 阶段 I。
set -euo pipefail

SERVER="${1:-223.105.56.202}"
SSH_PORT="${SSH_PORT:-51022}"
PLANE_DIR="${PLANE_DIR:-$HOME/Desktop/shu/plane}"

cd "$PLANE_DIR"

# VITE_ 变量是构建期烘焙（vite define），改地址必须重新构建；
# VITE_API_BASE_URL 留空 = 同源相对路径，plane api 经 nginx 4003 反代（勿直连 8001，安全组封禁）。
export VITE_API_BASE_URL=""
export VITE_EXPERTS_API_BASE_URL="http://${SERVER}:4002"
export VITE_RUNTIME_CONSOLE_BASE_URL="http://${SERVER}:4000"
export VITE_WEB_BASE_URL="http://${SERVER}:4003"
export VITE_ADMIN_BASE_URL="http://${SERVER}:4003"
export VITE_ADMIN_BASE_PATH="/god-mode"

# --force 必带：turbo 缓存不感知环境变量变化，否则拿到旧产物
pnpm exec turbo run build --filter=web --filter=admin --force

# 核对产物没有直连 8001 的残留
if grep -rl ":8001" apps/web/build/client/assets/*.js apps/admin/build/client/assets/*.js 2>/dev/null; then
  echo "❌ 产物中残留 :8001 直连地址，禁止上传"; exit 1
fi

COPYFILE_DISABLE=1 tar czf /tmp/plane-web-build.tar.gz -C apps/web/build/client .
COPYFILE_DISABLE=1 tar czf /tmp/plane-godmode.tar.gz -C apps/admin/build/client .
scp -P "$SSH_PORT" /tmp/plane-web-build.tar.gz /tmp/plane-godmode.tar.gz "dongqian@${SERVER}:/tmp/"
echo "✅ 构建产物已上传 ${SERVER}:/tmp/，服务器侧切换流程见 runbook §2 阶段 I"
