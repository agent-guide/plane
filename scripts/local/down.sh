#!/bin/bash
# 本地栈停止（幂等）。按精确命令行特征逐个停，绝不 pkill 模式串。
# 可选保留：bash scripts/local/down.sh --keep-infra（不停 PG/Redis）
set -euo pipefail
cd "$(dirname "$0")"
source lib/common.sh
KEEP_INFRA=0
for a in "$@"; do case "$a" in --keep-infra) KEEP_INFRA=1 ;; *) fail "未知参数 $a"; esac; done

step "停止本地栈"
stop_if_running "bin/airflow scheduler"     "Airflow scheduler"
stop_if_running "bin/airflow dag-processor" "Airflow dag-processor"
stop_if_running "bin/airflow api-server"    "Airflow api-server"
stop_if_running "procrastinate_worker.py"   "Plane 编排 worker"
stop_if_running "manage.py runserver"       "Plane API"
stop_if_running "apps/web"                  "Plane web（pnpm dev）"
stop_if_running "next dev --webpack -p $MGR_PORT" "agwmngr"
stop_if_running "agw run --config"          "agent-gateway"
stop_if_running "services/url-mcp" "url-mcp（链接读取 MCP）"
stop_if_running "weed server"                "SeaweedFS"
sleep 1
if [ $KEEP_INFRA -eq 0 ]; then
  pg_ctl -D "$HOME/homebrew/var/postgresql@15" stop -m fast >/dev/null 2>&1 && ok "PG 已停止" || miss "PG 未在运行"
  redis-cli -p $REDIS_PORT shutdown nosave 2>/dev/null && ok "Redis 已停止" || miss "Redis 未在运行"
else ok "保留 PG/Redis（--keep-infra）"; fi
echo; ok "down 完成"
