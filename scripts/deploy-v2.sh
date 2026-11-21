#!/usr/bin/env bash
# plane fork v2 栈一体化部署 —— Mac 侧执行，一条命令发完。
#
#   bash scripts/deploy-v2.sh [服务器IP] [--skip-web]
#
# 目标：v2 独立栈（不碰现役 v1——deploy.sh 管 v1，本脚本只动 v2/*）：
#   api   /opt/projects/ai-platform/v2/plane/api   → 127.0.0.1:8202（systemd plane-v2-api）
#   worker 同目录 procrastinate_worker.py          → systemd plane-v2-worker（PG 队列消费）
#   web   /opt/projects/ai-platform/v2/plane-web    → nginx :4004 静态
#   url-mcp 同仓 services/url-mcp → 127.0.0.1:8624（systemd url-mcp，链接读取 MCP 工具）
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
  # 依赖包先重编（发布纪律「依赖无条件同步」）：packages/* 全部按 dist 消费，
  # 谁机上 dist 旧谁部署就把旧代码打进 web——11-21 实证：编辑器未重编导致
  # 测试服评论工具栏丢「附件」按钮（11-19 c79258797 加的 attachment 项不在产物）。
  # turbo 按拓扑构建全部 @plane/* 包；失败即中止（fail-closed）。
  (cd "$REPO" && npx turbo run build --filter='@plane/*')
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

echo "==== [2/4] 打包 api + url-mcp + doc-mcp ===="
(cd "$REPO/apps/api" && COPYFILE_DISABLE=1 tar czf /tmp/plane-v2-api.tar.gz \
  --exclude=.venv --exclude=.env --exclude=.env.local --exclude=__pycache__ \
  --exclude=.pytest_cache --exclude=.git .)
# url-mcp：Mac 侧 esbuild（--target=node20）出单文件产物，服务器零 npm 零构建
(cd "$REPO/services/url-mcp" && npm run build >/dev/null && COPYFILE_DISABLE=1 tar czf /tmp/url-mcp-v2.tar.gz \
  server.ts tool.ts tools dist package.json README.md)
# doc-mcp：Python 服务源 + 共享解析包（apps/api 的 -e 依赖也指向 packages/，
# 远端解到 $V2ROOT/packages/ 供两边共用——单一权威源跨机保持）
COPYFILE_DISABLE=1 tar czf /tmp/doc-mcp-v2.tar.gz -C "$REPO/services/doc-mcp" \
  server.py ssrf.py tests requirements.txt README.md
COPYFILE_DISABLE=1 tar czf /tmp/document-parsing-v2.tar.gz -C "$REPO/packages/document-parsing" .

echo "==== [3/4] 上传 ===="
# scp 对老 sshd 偶发「传输完成后关通道报 Connection closed」（文件已完整落
# 远端）：报错后按远端大小校验兜底，一致则放行，不一致才真失败
_upload() {
  local file="$1" base; base="$(basename "$file")"
  local size; size="$(stat -f%z "$file")"
  local attempt
  for attempt in 1 2 3; do
    if scp -q -P "$SSH_PORT" "$file" "$REMOTE_USER@$SERVER:/tmp/"; then return 0; fi
    echo "⚠ scp 第 $attempt 次失败（Clash 代理间歇抽风常见），重试…"; sleep 3
  done
  echo "⚠ scp 报错，校验远端文件完整性（$base）…"
  local rsize
  rsize="$(ssh -p "$SSH_PORT" "$REMOTE_USER@$SERVER" "stat -c%s /tmp/$base 2>/dev/null" || echo 0)"
  if [ "$rsize" = "$size" ]; then
    echo "✔ 远端文件完整（$rsize 字节），继续（scp 关通道误报）"
    return 0
  fi
  echo "❌ 上传失败：远端 $rsize / 本地 $size 字节"; return 1
}
_upload /tmp/plane-v2-api.tar.gz
[ "$SKIP_WEB" -eq 0 ] && _upload /tmp/plane-v2-web.tar.gz
_upload /tmp/url-mcp-v2.tar.gz
_upload /tmp/doc-mcp-v2.tar.gz
_upload /tmp/document-parsing-v2.tar.gz
_upload "$REPO/scripts/systemd/doc-mcp.service"
_upload "$REPO/scripts/systemd/url-mcp.service"  # 单元模板随包走（模板是唯一权威，不内嵌副本）

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

# 共享解析包必须先就位：requirements 的 -e ../../packages/document-parsing
# 相对 api 目录解析到 $V2ROOT/packages/（原先在本脚本后段才解压 → pip 首装必失败）
mkdir -p "$V2ROOT/packages/document-parsing"
tar xzf /tmp/document-parsing-v2.tar.gz -C "$V2ROOT/packages/document-parsing"
find "$V2ROOT/packages/document-parsing" -name '._*' -delete 2>/dev/null || true

.venv/bin/pip install -r requirements.txt --prefer-binary -q > /tmp/plane-v2-pip.log 2>&1 \
  || { tail -10 /tmp/plane-v2-pip.log; echo "❌ pip install 失败"; exit 1; }

# 迁移（新模型变更在此落库；无变更时幂等 no-op）——env 与 systemd 单元同源
# （EnvironmentFile），不额外设 DJANGO_SETTINGS_MODULE（与运行态一致，用 manage.py 默认）
set -a; . "$V2ROOT/env/plane-api.env"; set +a
.venv/bin/python manage.py migrate > /tmp/plane-v2-migrate.log 2>&1 \
  || { tail -20 /tmp/plane-v2-migrate.log; echo "❌ migrate 失败"; exit 1; }

# 切换清理（2026-11-16 自研 outbox → Procrastinate 一次性迁移）：drain 旧
# pending 命令（按新 handler 执行收尾）——必须在 restart 前最后一步跑，
# 消除「老代码 drain 后、restart 前写入的行变孤儿」窗口；幂等可重跑
echo "---- drain legacy outbox (一次性，幂等) ----"
.venv/bin/python manage.py shell -c "
from plane.orchestration.worker import drain_outbox_once
print('drain:', drain_outbox_once())
from plane.orchestration.models import OrchestrationOutbox
n = OrchestrationOutbox.objects.filter(state=OrchestrationOutbox.State.PENDING).count()
print('legacy pending after drain:', n)
assert n == 0, 'drain 后仍有 pending——人工核查后再部署'
" || { echo "❌ drain 失败"; exit 1; }

sudo -n systemctl restart plane-v2-api plane-v2-worker \
  || { echo "❌ systemd 重启失败（需 passwordless sudo 或手动重启）"; exit 1; }

# worker 单元一致性防御：ExecStart 须指向 procrastinate_worker.py（2026-11-16
# 迁移）；旧单元仍指 worker_loop.py 会导致 restart 后 worker 起不来——
# 先跑 scripts/sync-systemd-units.sh 同步单元再部署
_active_exec=$(systemctl show -p ExecStart plane-v2-worker 2>/dev/null || true)
echo "$_active_exec" | grep -q "procrastinate_worker.py" \
  || { echo "❌ plane-v2-worker 单元仍是旧 ExecStart（worker_loop.py）——先执行 bash scripts/sync-systemd-units.sh $SERVER"; exit 1; }

# worker 探活（systemd active 即视为就绪；job 消费由库内机制自证）
sleep 3
sudo -n systemctl is-active --quiet plane-v2-worker \
  || { echo "❌ plane-v2-worker 未运行"; systemctl status plane-v2-worker --no-pager | tail -15; exit 1; }
echo "v2 worker: active"

# api 探活（8202 内网直连）
for _ in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8202/api/instances/ 2>/dev/null || echo 000)
  [ "$code" = "200" ] && break
  sleep 2
done
echo "v2 api 8202: $code"
[ "$code" = "200" ] || { echo "❌ v2 api 探活失败"; exit 1; }

# --- url-mcp：全量替换 + systemd 拉起（单元模板由 sync-systemd-units.sh 管理）---
rm -rf "$V2ROOT/url-mcp.new" && mkdir "$V2ROOT/url-mcp.new"
tar xzf /tmp/url-mcp-v2.tar.gz -C "$V2ROOT/url-mcp.new"
find "$V2ROOT/url-mcp.new" -name '._*' -delete 2>/dev/null || true
[ -x /usr/local/bin/node ] || { echo "❌ 服务器缺 node（/usr/local/bin/node）"; exit 1; }
rm -rf "$V2ROOT/url-mcp" && mv "$V2ROOT/url-mcp.new" "$V2ROOT/url-mcp"
if [ ! -f /etc/systemd/system/url-mcp.service ]; then
  echo "⚠ 首次部署：安装 url-mcp.service（来自仓库模板 /tmp/url-mcp.service）"
  [ -f /tmp/url-mcp.service ] || { echo "❌ 单元模板未上传（/tmp/url-mcp.service）"; exit 1; }
  sudo -n cp /tmp/url-mcp.service /etc/systemd/system/url-mcp.service && sudo -n systemctl daemon-reload \
    || { echo "❌ 单元安装失败（需 passwordless sudo）——先跑 bash scripts/sync-systemd-units.sh $SERVER"; exit 1; }
fi
sudo -n systemctl enable url-mcp >/dev/null 2>&1
sudo -n systemctl restart url-mcp
# 探活（8624；工具清单应含 url_reader）
for _ in $(seq 1 10); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8624/health 2>/dev/null || echo 000)
  [ "$code" = "200" ] && break
  sleep 1
done
tools=$(curl -s http://127.0.0.1:8624/health 2>/dev/null | grep -o 'url_reader' | head -1)
echo "url-mcp 8624: $code ($tools)"
[ "$code" = "200" ] && [ "$tools" = "url_reader" ] || { echo "❌ url-mcp 探活失败"; journalctl -u url-mcp -n 15 --no-pager 2>/dev/null; exit 1; }

# --- doc-mcp：全量替换 + 共享解析包（$V2ROOT/packages，apps/api 的 -e 依赖同源）
# .doc/.ppt 高质量引擎 LibreOffice 是系统级依赖（非 pip）：幂等安装/探活，
# 缺失不阻断部署（olefile 兜底可用），但显式提示降级。
if command -v soffice >/dev/null 2>&1; then
  echo "soffice: 已安装（$(soffice --version 2>/dev/null | head -1 | cut -d' ' -f2)）"
else
  echo "⚠ soffice 未安装，.doc/.ppt 走 olefile 兜底（中文可能带噪音）"
  if command -v apt-get >/dev/null 2>&1; then
    sudo -n apt-get install -y -q libreoffice-writer libreoffice-impress \
      && echo "已安装 libreoffice-writer/impress" \
      || echo "（自动安装失败——手动: sudo apt-get install libreoffice-writer libreoffice-impress）"
  fi
fi
mkdir -p "$V2ROOT/packages/document-parsing"
tar xzf /tmp/document-parsing-v2.tar.gz -C "$V2ROOT/packages/document-parsing"
find "$V2ROOT/packages/document-parsing" -name '._*' -delete 2>/dev/null || true
rm -rf "$V2ROOT/doc-mcp.new" && mkdir "$V2ROOT/doc-mcp.new"
tar xzf /tmp/doc-mcp-v2.tar.gz -C "$V2ROOT/doc-mcp.new"
find "$V2ROOT/doc-mcp.new" -name '._*' -delete 2>/dev/null || true
# venv 保留（.venv 不在 tar 内）：先挪出来再原子替换
[ -d "$V2ROOT/doc-mcp/.venv" ] && mv "$V2ROOT/doc-mcp/.venv" "$V2ROOT/doc-mcp.new/.venv"
rm -rf "$V2ROOT/doc-mcp" && mv "$V2ROOT/doc-mcp.new" "$V2ROOT/doc-mcp"
# venv 缺失或 requirements 变更（以 stamp 判）则重建
STAMP="$V2ROOT/doc-mcp/.venv/.req-stamp"
REQHASH="$(md5sum "$V2ROOT/doc-mcp/requirements.txt" | cut -d' ' -f1)"
if [ ! -x "$V2ROOT/doc-mcp/.venv/bin/python" ] || [ "$(cat "$STAMP" 2>/dev/null)" != "$REQHASH" ]; then
  echo "⚠ doc-mcp venv 重建（缺或依赖变更）"
  PY3=$(ls "$HOME"/.local/share/uv/python/cpython-3.12*/bin/python3.12 2>/dev/null | head -1)
  PY3=${PY3:-python3}
  "$PY3" -m venv "$V2ROOT/doc-mcp/.venv" \
    && "$V2ROOT/doc-mcp/.venv/bin/pip" install -q --upgrade pip \
    && "$V2ROOT/doc-mcp/.venv/bin/pip" install -q --only-binary :all: Pillow==12.2.0 \
    && "$V2ROOT/doc-mcp/.venv/bin/pip" install -q -r "$V2ROOT/doc-mcp/requirements.txt" \
    || { echo "❌ doc-mcp venv 构建失败"; exit 1; }
  echo "$REQHASH" > "$STAMP"
fi
if [ ! -f /etc/systemd/system/doc-mcp.service ]; then
  echo "⚠ 首次部署：安装 doc-mcp.service（来自上传模板）"
  sudo -n cp /tmp/doc-mcp.service /etc/systemd/system/doc-mcp.service && sudo -n systemctl daemon-reload \
    || { echo "❌ 单元安装失败（需 passwordless sudo）——先跑 sync-systemd-units.sh"; exit 1; }
fi
sudo -n systemctl enable doc-mcp >/dev/null 2>&1
sudo -n systemctl restart doc-mcp
for _ in $(seq 1 10); do
  dcode=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8625/health 2>/dev/null || echo 000)
  [ "$dcode" = "200" ] && break
  sleep 1
done
dtools=$(curl -s http://127.0.0.1:8625/health 2>/dev/null | grep -o 'parse_document' | head -1)
echo "doc-mcp 8625: $dcode ($dtools)"
[ "$dcode" = "200" ] && [ "$dtools" = "parse_document" ] || { echo "❌ doc-mcp 探活失败"; journalctl -u doc-mcp -n 15 --no-pager 2>/dev/null; exit 1; }
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
echo "ℹ url_reader / parse_document 平台链注册（幂等，服务器上执行；两个都跑——"
echo "  含 ①b 网关私有 MCP 路由，ACP 型 agent 挂工具的前置；凭据按测试服实际值覆盖）："
echo "  AGWMNGR=http://127.0.0.1:4005 GW_ID=<测试服网关ID> TENANT=<测试服租户> \\"
echo "  ADMIN_USER=<超管> ADMIN_PASS=<密码> bash scripts/bootstrap-url-reader.sh"
echo "  AGWMNGR=http://127.0.0.1:4005 GW_ID=<测试服网关ID> TENANT=<测试服租户> \\"
echo "  ADMIN_USER=<超管> ADMIN_PASS=<密码> bash scripts/bootstrap-doc-parser.sh"
