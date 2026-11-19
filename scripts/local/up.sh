#!/bin/bash
# 本地全栈拉起（幂等）：PG → Redis → SeaweedFS → url-mcp → gateway → Airflow(签 token) → api → worker
# → web → agwmngr。顺序关键：api/worker 必须在 Airflow token 签回 .env 之后启动，
# 否则发布/engine.start 拿不到 ORCHESTRATION_AIRFLOW_* 会静默走无引擎过渡（DAG 不落地）。
# 每步 fail-closed：探活校验响应体。
#   bash scripts/local/up.sh [--skip-airflow] [--skip-web]
set -euo pipefail
cd "$(dirname "$0")"
source lib/common.sh
SKIP_AF=0; SKIP_WEB=0
for a in "$@"; do case "$a" in
  --skip-airflow) SKIP_AF=1 ;; --skip-web) SKIP_WEB=1 ;;
  *) fail "未知参数 ${a}（支持 --skip-airflow --skip-web）" ;; esac; done
mkdir -p /tmp/agent-team-dags

step "① 基础设施（PG :${PG_PORT} / Redis :${REDIS_PORT}）"
if nc -z 127.0.0.1 $PG_PORT 2>/dev/null; then ok "PG 已在运行"; else
  pg_ctl -D "$HOME/homebrew/var/postgresql@15" -l "$HOME/homebrew/var/pg.log" start >/dev/null 2>&1 || fail "PG 启动失败（先跑 bootstrap.sh）"
  wait_port $PG_PORT 15 "PG"; ok "PG 已启动"; fi
psql -h 127.0.0.1 -d postgres -tc "SELECT 1 FROM pg_roles WHERE rolname='plane'" | grep -q 1 || \
  psql -h 127.0.0.1 -d postgres -c "CREATE ROLE plane WITH LOGIN SUPERUSER PASSWORD 'plane'" >/dev/null
psql -h 127.0.0.1 -d plane -tc 'SELECT 1' >/dev/null 2>&1 || psql -h 127.0.0.1 -d postgres -c 'CREATE DATABASE plane OWNER plane' >/dev/null
ok "库 plane 就绪"
if redis-cli -p $REDIS_PORT ping 2>/dev/null | grep -q PONG; then ok "Redis 已在运行"; else
  redis-server --daemonize yes --port $REDIS_PORT && ok "Redis 已启动" || fail "Redis 启动失败"; fi

step "② SeaweedFS S3（:9000，附件存储）"
WEED_DIR="$HOME/seaweedfs"; WEED="$WEED_DIR/weed"
[ -x "$WEED" ] || fail "weed 缺失 —— 先跑 bootstrap.sh（或见 README 手动下载 darwin_arm64）"
if curl -s -o /dev/null --max-time 3 http://127.0.0.1:9000/ 2>/dev/null; then ok "SeaweedFS 已在运行"; else
  stop_if_running "weed server" "weed 残留"
  mkdir -p "$WEED_DIR/data"
  [ -f "$WEED_DIR/data/s3-config.json" ] || cat > "$WEED_DIR/data/s3-config.json" <<'EOF'
{"identities":[{"name":"plane","credentials":[{"accessKey":"plane","secretKey":"plane12345"}],"actions":["Admin","Read","Write"]}]}
EOF
  nohup "$WEED" server -dir="$WEED_DIR/data" -volume.max=200 -s3 -s3.config="$WEED_DIR/data/s3-config.json" \
    -ip=127.0.0.1 -s3.port=9000 -master.port=9333 -volume.port=8081 > /tmp/weed.log 2>&1 &
  SECONDS=0; until curl -s -o /dev/null --max-time 3 http://127.0.0.1:9000/; do
    [ $SECONDS -ge 20 ] && fail "SeaweedFS 未就绪（/tmp/weed.log）"; sleep 2; done
  ok "SeaweedFS 已启动"; fi
# 桶（幂等：缺则建）
if ! echo 's3.bucket.list' | "$WEED" shell -master=127.0.0.1:9333 2>/dev/null | grep -q uploads; then
  echo 's3.bucket.create -name uploads' | "$WEED" shell -master=127.0.0.1:9333 >/dev/null 2>&1; fi
ok "bucket uploads 就绪"

step "③ url-mcp（:8624，链接读取 MCP 工具）"
URL_MCP_DIR="$PWD/../../services/url-mcp"
URL_MCP="$URL_MCP_DIR/server.ts"
[ -f "$URL_MCP" ] || fail "url-mcp 缺失：$URL_MCP"
# node ≥23 直跑 TS（零构建）；<23（如测试服 node 20）先 esbuild 出产物再跑
NODE_MAJOR=$(node -p 'Number(process.versions.node.split(".")[0])')
URL_MCP_RUN="$URL_MCP"
if [ "$NODE_MAJOR" -lt 23 ]; then
  hint "node ${NODE_MAJOR} <23，走构建产物形态（esbuild）"
  (cd "$URL_MCP_DIR" && npm ci --silent >/dev/null 2>&1 && npm run build >/dev/null) \
    || fail "url-mcp 构建失败（cd services/url-mcp && npm run build 看报错）"
  URL_MCP_RUN="$URL_MCP_DIR/dist/index.mjs"
fi
if probe_contains "http://127.0.0.1:8624/health" '"ok"\|{}'; then
  ok "url-mcp 已在运行"; else
  stop_if_running "services/url-mcp" "url-mcp 残留"
  nohup node "$URL_MCP_RUN" > /tmp/url-mcp.log 2>&1 &
  SECONDS=0; until curl -s -o /dev/null --max-time 2 http://127.0.0.1:8624/health; do
    [ $SECONDS -ge 8 ] && { fail "url-mcp 探活失败"; hint "看 /tmp/url-mcp.log"; }; sleep 1; done
  ok "url-mcp 已启动（$([ "$NODE_MAJOR" -lt 23 ] && echo 构建产物 || echo TS 直跑)）"; fi

step "④ agent-gateway（:${GW_DATA_PORT} / :${GW_ADMIN_PORT}）"
[ -x "$GW_DIR/agw" ] || fail "网关二进制缺失 —— cd $GW_DIR && git checkout v0.8.0-preview.1 && make build"
if probe_contains "http://localhost:$GW_ADMIN_PORT/admin/health" '"status"' -u "$GW_ADMIN_USER:$GW_ADMIN_PASSWORD"; then
  ok "gateway 已在运行"; else
  stop_if_running "agw run --config" "gateway 残留"
  (cd "$GW_DIR" && mkdir -p data && nohup ./agw run --config Caddyfile.local > /tmp/agw.log 2>&1 &)
  SECONDS=0; until probe_contains "http://localhost:$GW_ADMIN_PORT/admin/health" '"status"' -u "$GW_ADMIN_USER:$GW_ADMIN_PASSWORD"; do
    [ $SECONDS -ge 15 ] && { fail "gateway 探活失败"; hint "看 /tmp/agw.log；Caddyfile.local 未生成则重跑 gen-env.sh"; }; sleep 1; done
  ok "gateway 已启动"; fi

# ── Airflow 必须早于 api/worker：worker/发布路径读 ORCHESTRATION_AIRFLOW_* ──
if [ $SKIP_AF -eq 0 ]; then
step "⑤ Airflow 三件套 + token 签回（:${AIRFLOW_PORT}）"
export AIRFLOW_HOME=$AIRFLOW_HOME_DIR
export AIRFLOW__DATABASE__SQL_ALCHEMY_CONN="sqlite:////$AIRFLOW_HOME_DIR/airflow.db"
export AIRFLOW__CORE__EXECUTOR=LocalExecutor
export AIRFLOW__CORE__DAGS_FOLDER=/tmp/agent-team-dags
export AIRFLOW__DAG_PROCESSOR__REFRESH_INTERVAL=15
export AIRFLOW__API__BASE_URL="http://127.0.0.1:$AIRFLOW_PORT"
export ORCHESTRATION_INTERNAL_BASE_URL="http://127.0.0.1:$API_PORT"
export ORCHESTRATION_INTERNAL_TOKEN="$ORCH_TOKEN"
AF="$AIRFLOW_HOME_DIR/.venv/bin/airflow"
if probe_contains "http://127.0.0.1:$AIRFLOW_PORT/api/v2/monitor/health" 'healthy\|ok'; then ok "Airflow 已在运行"; else
  [ -x "$AF" ] || fail "Airflow 未安装 —— 先跑 bootstrap.sh"
  for unit in api-server dag-processor scheduler; do stop_if_running "bin/airflow $unit" "airflow $unit"; done
  nohup "$AF" api-server --port $AIRFLOW_PORT > /tmp/af-api.log 2>&1 &
  nohup "$AF" dag-processor > /tmp/af-dagproc.log 2>&1 &
  nohup "$AF" scheduler > /tmp/af-sched.log 2>&1 &
  SECONDS=0; until probe_contains "http://127.0.0.1:$AIRFLOW_PORT/api/v2/monitor/health" 'healthy\|ok'; do
    [ $SECONDS -ge 30 ] && fail "Airflow 探活失败（/tmp/af-*.log）"; sleep 2; done
  ok "Airflow 三件套已启动"; fi
AF_PW="$(python3 -c "import json;print(json.load(open('$AIRFLOW_HOME_DIR/simple_auth_manager_passwords.json.generated'))['admin'])")"
AF_TOKEN="$(curl -sf -X POST "http://127.0.0.1:$AIRFLOW_PORT/auth/token" -H 'Content-Type: application/json' -d "{\"username\":\"admin\",\"password\":\"$AF_PW\"}" | python3 -c 'import json,sys;print(json.load(sys.stdin)["access_token"])')" \
  || fail "Airflow token 签发失败"
sed -i '' "s|^ORCHESTRATION_AIRFLOW_TOKEN=.*|ORCHESTRATION_AIRFLOW_TOKEN=$AF_TOKEN|" "$API_DIR/.env"
grep -q '^ORCHESTRATION_AIRFLOW_TOKEN=' "$API_DIR/.env" || echo "ORCHESTRATION_AIRFLOW_TOKEN=$AF_TOKEN" >> "$API_DIR/.env"
ok "ORCHESTRATION_AIRFLOW_TOKEN 已签回 .env"
fi

step "⑥ Plane API（:${API_PORT}）+ worker"
# 强制重启 api（不跳过已运行实例）：.env 可能在本次 up 前被 gen-env/provision 改过，
# 跳过会让 api 带旧 env 运行（Docker 主机名/空 token 类漂移根源，2026-11-17 实证）。
# dev server 重启代价 ~10s，稳定性优先。
stop_if_running "manage.py runserver" "plane api（强制重启保 env 新鲜）"
(cd "$API_DIR" && set -a && source .env && set +a && \
 nohup .venv/bin/python manage.py runserver "0.0.0.0:$API_PORT" --settings=plane.settings.local > /tmp/plane-api.log 2>&1 &)
wait_port $API_PORT 30 "plane api"
probe_contains "http://127.0.0.1:$API_PORT/api/instances/" 'is_setup_done' || fail "api 探活失败（/tmp/plane-api.log）"
ok "plane api 已启动"
stop_if_running "procrastinate_worker.py" "worker 残留"
(cd "$API_DIR" && set -a && source .env && set +a && export DJANGO_SETTINGS_MODULE=plane.settings.local && \
 nohup .venv/bin/python procrastinate_worker.py > /tmp/plane-worker.log 2>&1 &)
sleep 3; pgrep -f procrastinate_worker.py >/dev/null || fail "worker 启动失败（/tmp/plane-worker.log）"
ok "编排 worker 已启动（Procrastinate 单实例）"

if [ $SKIP_WEB -eq 0 ]; then
step "⑦ Plane web（:${WEB_PORT}）"
if probe_http 200 "http://localhost:$WEB_PORT/"; then ok "web 已在运行"; else
  stop_if_running "apps/web" "web"
  (cd "$WEB_DIR" && nohup pnpm dev > /tmp/plane-web.log 2>&1 &)
  SECONDS=0; until probe_http 200 "http://localhost:$WEB_PORT/"; do
    [ $SECONDS -ge 60 ] && { fail "web 探活失败"; hint "看 /tmp/plane-web.log；首次需 packages 已 build（bootstrap.sh）"; }; sleep 2; done
  ok "web 已启动"; fi
fi

step "⑧ agwmngr（:${MGR_PORT}）"
if probe_contains "http://127.0.0.1:$MGR_PORT/api/admin/health" 'ok\|{}'; then ok "agwmngr 已在运行"; else
  stop_if_running "next dev --webpack -p $MGR_PORT" "agwmngr"
  (cd "$MGR_DIR" && nohup node node_modules/next/dist/bin/next dev --webpack -p $MGR_PORT > /tmp/agwmngr.log 2>&1 &)
  SECONDS=0; until probe_contains "http://127.0.0.1:$MGR_PORT/api/admin/health" 'ok\|{}'; do
    [ $SECONDS -ge 40 ] && { fail "agwmngr 探活失败"; hint "看 /tmp/agwmngr.log；首次需 bun install + .env.local（gen-env.sh）"; }; sleep 2; done
  ok "agwmngr 已启动"; fi

step "⑨ 状态汇总"
bash ./check.sh || true
echo; echo "  ✅ up 完成。冒烟：bash scripts/local/smoke.sh"
