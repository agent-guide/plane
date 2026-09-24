#!/usr/bin/env bash
# plane fork 一体化部署 —— Mac 侧执行，一条命令发完本仓库全部交付物。
#
#   bash scripts/deploy.sh [服务器IP] [--skip-web]
#
# 默认全量：构建 web 工作台+god-mode（Mac 构建，CentOS glibc 过老）→ 打包 api
# → 上传产物与本脚本族 → 远端执行更新（api 换码+配置补发+安全重启；web 静态原子切换）。
# --skip-web：只发 api（web 未变更时）。
# 服务器侧动作内嵌在本脚本尾部（通过 ssh 远端执行），不再有独立的服务器脚本。
set -euo pipefail

SERVER="${1:-223.105.56.202}"
[[ "${2:-}" == "--skip-web" || "${3:-}" == "--skip-web" ]] && SKIP_WEB=1 || SKIP_WEB=0
SSH_PORT="${SSH_PORT:-51022}"
REMOTE_USER="${REMOTE_USER:-dongqian}"
PLATFORM="/opt/projects/ai-platform"
REPO="$(cd "$(dirname "$0")/.." && pwd)"

echo "==== [1/4] 构建 plane 前端（Mac）===="
if [ "$SKIP_WEB" -eq 1 ]; then
  echo "⏭ --skip-web：跳过前端构建"
else
  (
    cd "$REPO"
    export VITE_API_BASE_URL=""
    export VITE_EXPERTS_API_BASE_URL="http://${SERVER}:4002"
    export VITE_RUNTIME_CONSOLE_BASE_URL="http://${SERVER}:4000"
    export VITE_WEB_BASE_URL="http://${SERVER}:4003"
    export VITE_ADMIN_BASE_URL="http://${SERVER}:4003"
    export VITE_ADMIN_BASE_PATH="/god-mode"
    # --force 必带：turbo 缓存不感知环境变量，否则拿到旧产物
    pnpm exec turbo run build --filter=web --filter=admin --force
  )
  if grep -rl ":8001" "$REPO/apps/web/build/client/assets/"*.js "$REPO/apps/admin/build/client/assets/"*.js 2>/dev/null; then
    echo "❌ 前端产物残留 :8001 直连地址，中止"; exit 1
  fi
  COPYFILE_DISABLE=1 tar czf /tmp/plane-web-build.tar.gz -C "$REPO/apps/web/build/client" .
  COPYFILE_DISABLE=1 tar czf /tmp/plane-godmode.tar.gz -C "$REPO/apps/admin/build/client" .
fi

echo "==== [2/4] 打包 api ===="
(cd "$REPO/apps/api" && COPYFILE_DISABLE=1 tar czf /tmp/plane-api-pkg.tar.gz \
  --exclude=.venv --exclude=.env --exclude=.env.local --exclude=__pycache__ \
  --exclude=.pytest_cache --exclude=.git .)

echo "==== [3/4] 上传 ===="
scp -q -P "$SSH_PORT" /tmp/plane-api-pkg.tar.gz "$REMOTE_USER@$SERVER:$PLATFORM/"
[ "$SKIP_WEB" -eq 0 ] && scp -q -P "$SSH_PORT" /tmp/plane-web-build.tar.gz /tmp/plane-godmode.tar.gz "$REMOTE_USER@$SERVER:/tmp/"

echo "==== [4/4] 服务器更新 ===="
ssh -p "$SSH_PORT" "$REMOTE_USER@$SERVER" PLATFORM="$PLATFORM" 'bash -s' <<'REMOTE'
set -uo pipefail
PLATFORM="${PLATFORM:?}"
API_DIR="$PLATFORM/plane/apps/api"

# --- api：换码（保留 .venv/.env/scripts）+ 配置补发 + 安全重启 ---
if [ -f "$API_DIR/.env" ]; then cp "$API_DIR/.env" /tmp/plane-api.env.bak; fi
cd "$API_DIR"
find . -maxdepth 1 -not -name '.' -not -name '.venv' -not -name '.env' \
  -not -name '.env.local' -not -name 'scripts' -exec rm -rf {} +
tar xzf "$PLATFORM/plane-api-pkg.tar.gz" 2>/dev/null
find . -name '._*' -delete 2>/dev/null || true
[ -f /tmp/plane-api.env.bak ] && cp /tmp/plane-api.env.bak .env
# 依赖同步：无条件 pip install——对已满足的钉版依赖 pip 本地短路
# （Requirement already satisfied，不联网），幂等由工具原生保证，不引入外部指纹。
.venv/bin/pip install -r requirements.txt --prefer-binary -q > /tmp/plane-pip.log 2>&1 \
  || { tail -10 /tmp/plane-pip.log; echo "pip install 失败"; exit 1; }

# 配置补发（幂等：只补缺失键；功能迭代新增 .env 键在此登记）
ENV_FILE="$API_DIR/.env"
declare -A KEYS=(
  [WEBHOOK_ALLOWED_IPS]="127.0.0.0/8,::1/128"
  [WEBHOOK_ALLOWED_HOSTS]="127.0.0.1"
)
for key in "${!KEYS[@]}"; do
  if ! grep -q "^$key=" "$ENV_FILE" 2>/dev/null; then
    echo "$key=${KEYS[$key]}" >> "$ENV_FILE"; echo "＋ $key 已补发"
  fi
done

# 安全重启（校验 /proc exe 再 kill；命令行含模式串会自杀）：
# api 与 celery 都要重启——webhook 载荷序列化在 celery 进程内完成，
# 只重启 api 会出现 serializer 改动不生效的假象。
PAT="run""server 0.0.0.0:8001"
for p in $(pgrep -f "$PAT"); do
  case "$(readlink /proc/$p/exe 2>/dev/null)" in
    *python*) kill $p 2>/dev/null ;;
  esac
done
CELERY_PAT="celery"" -A plane worker"
for p in $(pgrep -f "$CELERY_PAT"); do
  case "$(readlink /proc/$p/exe 2>/dev/null)" in
    *python*) kill $p 2>/dev/null && echo "  celery killed $p" ;;
  esac
done
sleep 2
set -a; . ./.env; set +a
export DJANGO_SETTINGS_MODULE=plane.settings.local
nohup .venv/bin/python manage.py runserver 0.0.0.0:8001 >> "$PLATFORM/logs/plane-api.log" 2>&1 &
nohup .venv/bin/python -m celery -A plane worker -l info -Q celery >> "$PLATFORM/logs/plane-celery.log" 2>&1 &
# 探活轮询（最多 60s），失败不让远端块以非零退出（web 切换仍应继续）
for _ in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8001/api/instances/ 2>/dev/null || echo 000)
  [ "$code" = "200" ] && break
  sleep 2
done
echo "plane api: $code"
exit 0
REMOTE

if [ "$SKIP_WEB" -eq 0 ]; then
ssh -p "$SSH_PORT" "$REMOTE_USER@$SERVER" PLATFORM="$PLATFORM" 'bash -s' <<'REMOTE'
set -euo pipefail
PLATFORM="${PLATFORM:?}"
# --- web：静态原子切换 ---
rm -rf "$PLATFORM/plane-web.new" && mkdir -p "$PLATFORM/plane-web.new"
tar xzf /tmp/plane-web-build.tar.gz -C "$PLATFORM/plane-web.new" 2>/dev/null
rm -rf "$PLATFORM/plane-web.old" "$PLATFORM/plane-web"
mv "$PLATFORM/plane-web.new" "$PLATFORM/plane-web"
chmod -R o+rX "$PLATFORM/plane-web"
# --- god-mode ---
rm -rf "$PLATFORM/plane-godmode" && mkdir -p "$PLATFORM/plane-godmode"
tar xzf /tmp/plane-godmode.tar.gz -C "$PLATFORM/plane-godmode" 2>/dev/null
chmod -R o+rX "$PLATFORM/plane-godmode"
curl -s -o /dev/null -w "web 首页: %{http_code}\n" http://127.0.0.1:4003/
curl -s -o /dev/null -w "god-mode: %{http_code}\n" http://127.0.0.1:4003/god-mode/
REMOTE
fi

echo "✅ plane fork 部署完成（api$([ "$SKIP_WEB" -eq 0 ] && echo ' + web + god-mode')）"
