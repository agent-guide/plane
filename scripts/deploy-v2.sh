#!/usr/bin/env bash
# plane fork v2 栈一体化部署 —— Mac 侧执行，一条命令发完。
#
#   bash scripts/deploy-v2.sh [服务器IP] [--skip-web]
#
# 目标：v2 独立栈（不碰现役 v1——deploy.sh 管 v1，本脚本只动 v2/*）：
#   api   /opt/projects/ai-platform/v2/plane/api   → 127.0.0.1:8202（systemd plane-v2-api）
#   worker 同目录 worker_loop.py                    → systemd plane-v2-worker
#   web   /opt/projects/ai-platform/v2/plane-web    → nginx :4004 静态
# 发布纪律与 v1 deploy.sh 同源：全量打包+完整替换（不留幽灵文件）、
# 依赖无条件同步（幂等由工具保证）、构建产物校验、探活失败即中止。
set -euo pipefail

SERVER="${1:-223.105.56.202}"
[[ "${2:-}" == "--skip-web" || "${3:-}" == "--skip-web" ]] && SKIP_WEB=1 || SKIP_WEB=0
SSH_PORT="${SSH_PORT:-51022}"
REMOTE_USER="${REMOTE_USER:-dongqian}"
V2ROOT="/opt/projects/ai-platform/v2"
REPO="$(cd "$(dirname "$0")/.." && pwd)"

echo "==== [1/4] 构建 v2 前端（Mac）===="
if [ "$SKIP_WEB" -eq 1 ]; then
  echo "⏭ --skip-web：跳过前端构建"
else
  (
    cd "$REPO/apps/web"
    # 地址构建期烧进产物（dual-deploy-plan §3.2）：同源相对路径 + 4004 公网入口。
    # dotenv 不覆盖已存在的 shell 变量，.env 里的 localhost 联调值被此处覆盖。
    VITE_API_BASE_URL="" \
    VITE_WEB_BASE_URL="http://${SERVER}:4004" \
    VITE_ADMIN_BASE_URL="http://${SERVER}:4004" \
    VITE_SPACE_BASE_URL="http://${SERVER}:4004" \
    VITE_LIVE_BASE_URL="http://${SERVER}:4004" \
    VITE_RUNTIME_CONSOLE_BASE_URL="" \
    VITE_EXPERTS_API_BASE_URL="" \
    npx react-router build
  )
  if grep -rl "localhost:8001" "$REPO/apps/web/build/client/assets/"*.js 2>/dev/null; then
    echo "❌ 前端产物残留 localhost:8001 直连地址，中止"; exit 1
  fi
  COPYFILE_DISABLE=1 tar czf /tmp/plane-v2-web.tar.gz -C "$REPO/apps/web/build/client" .
fi

echo "==== [2/4] 打包 api ===="
(cd "$REPO/apps/api" && COPYFILE_DISABLE=1 tar czf /tmp/plane-v2-api.tar.gz \
  --exclude=.venv --exclude=.env --exclude=.env.local --exclude=__pycache__ \
  --exclude=.pytest_cache --exclude=.git .)

echo "==== [3/4] 上传 ===="
scp -q -P "$SSH_PORT" /tmp/plane-v2-api.tar.gz "$REMOTE_USER@$SERVER:/tmp/"
[ "$SKIP_WEB" -eq 0 ] && scp -q -P "$SSH_PORT" /tmp/plane-v2-web.tar.gz "$REMOTE_USER@$SERVER:/tmp/"

echo "==== [4/4] 服务器更新（v2）===="
ssh -p "$SSH_PORT" "$REMOTE_USER@$SERVER" V2ROOT="$V2ROOT" 'bash -s' <<'REMOTE'
set -uo pipefail
V2ROOT="${V2ROOT:?}"
API_DIR="$V2ROOT/plane/api"

# --- api：换码（保留 .venv/.env）+ 依赖同步 + 迁移 + 重启 ---
if [ -f "$API_DIR/.env" ]; then cp "$API_DIR/.env" /tmp/plane-v2-api.env.bak; fi
cd "$API_DIR"
find . -maxdepth 1 -not -name '.' -not -name '.venv' -not -name '.env' \
  -not -name '.env.local' -exec rm -rf {} +
tar xzf /tmp/plane-v2-api.tar.gz 2>/dev/null
find . -name '._*' -delete 2>/dev/null || true
[ -f /tmp/plane-v2-api.env.bak ] && cp /tmp/plane-v2-api.env.bak .env

.venv/bin/pip install -r requirements.txt --prefer-binary -q > /tmp/plane-v2-pip.log 2>&1 \
  || { tail -10 /tmp/plane-v2-pip.log; echo "❌ pip install 失败"; exit 1; }

# 迁移（新模型变更在此落库；无变更时幂等 no-op）——env 与 systemd 单元同源
# （EnvironmentFile），不额外设 DJANGO_SETTINGS_MODULE（与运行态一致，用 manage.py 默认）
set -a; . "$V2ROOT/env/plane-api.env"; set +a
.venv/bin/python manage.py migrate > /tmp/plane-v2-migrate.log 2>&1 \
  || { tail -20 /tmp/plane-v2-migrate.log; echo "❌ migrate 失败"; exit 1; }

sudo -n systemctl restart plane-v2-api plane-v2-worker \
  || { echo "❌ systemd 重启失败（需 passwordless sudo 或手动重启）"; exit 1; }

# api 探活（8202 内网直连）
for _ in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8202/api/instances/ 2>/dev/null || echo 000)
  [ "$code" = "200" ] && break
  sleep 2
done
echo "v2 api 8202: $code"
[ "$code" = "200" ] || { echo "❌ v2 api 探活失败"; exit 1; }
REMOTE

if [ "$SKIP_WEB" -eq 0 ]; then
ssh -p "$SSH_PORT" "$REMOTE_USER@$SERVER" V2ROOT="$V2ROOT" 'bash -s' <<'REMOTE'
set -euo pipefail
V2ROOT="${V2ROOT:?}"
# --- web：静态原子切换（v2/plane-web 由 nginx :4004 直读）---
rm -rf "$V2ROOT/plane-web.new" && mkdir "$V2ROOT/plane-web.new"
tar xzf /tmp/plane-v2-web.tar.gz -C "$V2ROOT/plane-web.new"
find "$V2ROOT/plane-web.new" -name '._*' -delete 2>/dev/null || true
rm -rf "$V2ROOT/plane-web.old"
[ -d "$V2ROOT/plane-web" ] && mv "$V2ROOT/plane-web" "$V2ROOT/plane-web.old"
mv "$V2ROOT/plane-web.new" "$V2ROOT/plane-web"
# 探活：nginx 同源反代到 8202，首页与 API 都要通
for _ in $(seq 1 15); do
  web=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4004/ 2>/dev/null || echo 000)
  api=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4004/api/instances/ 2>/dev/null || echo 000)
  [ "$web" = "200" ] && [ "$api" = "200" ] && break
  sleep 2
done
echo "v2 web 4004: $web / api: $api"
if [ "$web" != "200" ] || [ "$api" != "200" ]; then
  echo "❌ v2 web 探活失败，回滚静态包"
  rm -rf "$V2ROOT/plane-web" && mv "$V2ROOT/plane-web.old" "$V2ROOT/plane-web"
  exit 1
fi
rm -rf "$V2ROOT/plane-web.old"
REMOTE
fi

echo "✅ v2 栈部署完成（v1 现役栈未动）"
