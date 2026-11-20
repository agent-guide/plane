#!/bin/bash
# 本地栈脚本共用库（up/down/check/provision source）——随 scripts/local/ 整体入库。
# 2026-11-20 重建：原文件随 force-add 漏库，此版按四个脚本的引用面重建，
# 端口/路径对齐本仓现行本地栈（见 docs/v2/new-machine-onboarding.md）。

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_DIR="$REPO_ROOT/apps/api"
WEB_DIR="$REPO_ROOT/apps/web"
GW_DIR="$HOME/Desktop/shu/agent-gateway"
MGR_DIR="$HOME/Desktop/shu/experts-frontend/agwmngr"
URL_MCP_DIR="$REPO_ROOT/services/url-mcp"
DOC_MCP_DIR="$REPO_ROOT/services/doc-mcp"

PG_PORT=5432
REDIS_PORT=6379
API_PORT=8001
WEB_PORT=3000
GW_ADMIN_PORT=8019
GW_ID="gw-local"   # agwmngr 注册的网关 ID
MGR_PORT=3300
AIRFLOW_PORT=8090
AIRFLOW_HOME_DIR="$HOME/Desktop/shu/airflow-home"   # 本机实际位置（up.sh 原值 $HOME/airflow-home）
AF="$HOME/Desktop/shu/airflow-venv/bin/airflow"

# 凭据（本地开发约定；生产/测试服绝不使用）
PSQL="/Users/shadow/pgsql/bin/psql"   # 本机自编译 PG 客户端（PATH 无 psql）
REDIS_CLI="/Users/shadow/plane-data/redis/redis-7.2.12/src/redis-cli"  # 同上
DB_URL="$(grep -E '^DATABASE_URL=' "$API_DIR/.env" | cut -d= -f2-)"

GW_ADMIN_USER="admin"
GW_ADMIN_PASSWORD="dummy"
# plane→agwmngr 平台链凭据（从 api .env 提取，避免双处维护）
TENANT_ID="$(grep -E '^AGWMNGR_TENANT_ID=' "$API_DIR/.env" | cut -d= -f2-)"
TENANT_TOKEN="$(grep -E '^AGWMNGR_TENANT_TOKEN=' "$API_DIR/.env" | cut -d= -f2-)"

MGR_ADMIN_USER="localadmin"
MGR_ADMIN_PASSWORD="localdev123"

step() { echo "==== $* ===="; }
ok()   { echo "  ✅ $*"; }
fail() { echo "  ❌ $*" >&2; exit 1; }
hint() { echo "  💡 $*"; }

wait_port() { # wait_port <port> <timeout_s> <name>
  local port=$1 t=$2 name=$3 s=0
  until nc -z 127.0.0.1 "$port" 2>/dev/null; do
    [ $s -ge "$t" ] && return 1
    sleep 1; s=$((s + 1))
  done
}

probe_http() { # probe_http <expect_code> <url> [curl args...]
  local expect=$1 url=$2; shift 2
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$@" "$url" 2>/dev/null)" = "$expect" ]
}

probe_contains() { # probe_contains <url> <pattern> [curl args...]
  local url=$1 pat=$2; shift 2
  curl -s "$@" "$url" 2>/dev/null | grep -q "$pat"
}

stop_if_running() { # stop_if_running <pgrep-pattern> <label> —— 精确清进程（防自匹配用 [x]xx 形式）
  local pat=$1 label=$2 pids
  pids=$(pgrep -f "$pat" || true)
  if [ -n "$pids" ]; then
    echo "$pids" | xargs kill 2>/dev/null || true
    sleep 2
    pgrep -f "$pat" >/dev/null && fail "$label 未停止（pids: $(pgrep -f "$pat")）" || ok "$label 已停止"
  else
    ok "$label 未在运行"
  fi
}
