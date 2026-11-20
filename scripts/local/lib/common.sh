#!/bin/bash
# 本地栈脚本共用库（up/down/check/provision source）——随 scripts/local/ 整体入库。
#
# 机器相关值（凭据/网关 ID/仓库目录/airflow 路径）一律从 scripts/local/.env
# 读取（gitignored，每台机各一份，由 gen-env.sh 按 env.example 生成）；
# 二进制路径优先 command -v 探测、探测不到回退 .env 显式覆盖。本文件只放
# 公共逻辑 + 两台机一致的端口默认值，不落任何秘密或机器绝对路径。
# （2026-11-20 修正：上一版把 shadow 机的绝对路径与凭据硬编码入库，双机冲突。）

_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── 机器相关配置：source 本机 .env（gitignored）──
if [ -f "$_SCRIPT_DIR/../.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$_SCRIPT_DIR/../.env"
  set +a
fi

# ── 仓库根/子目录（代码布局两台机一致）──
REPO_ROOT="$(cd "$_SCRIPT_DIR/../../.." && pwd)"
API_DIR="$REPO_ROOT/apps/api"
WEB_DIR="$REPO_ROOT/apps/web"
URL_MCP_DIR="$REPO_ROOT/services/url-mcp"
DOC_MCP_DIR="$REPO_ROOT/services/doc-mcp"

# ── 仓库/工具目录（机器相关，.env 可覆盖，缺省按约定）──
GW_DIR="${GW_DIR:-$HOME/Desktop/shu/agent-gateway}"
MGR_DIR="${MGR_DIR:-$HOME/Desktop/shu/agwmngr}"
AIRFLOW_HOME_DIR="${AIRFLOW_HOME_DIR:-$HOME/airflow-local}"
AF="${AF:-$AIRFLOW_HOME_DIR/.venv/bin/airflow}"

# ── 端口（env.example 统一口径，缺省兜底）──
PG_PORT="${PG_PORT:-5432}"
REDIS_PORT="${REDIS_PORT:-6379}"
API_PORT="${API_PORT:-8001}"
WEB_PORT="${WEB_PORT:-3000}"
GW_ADMIN_PORT="${GW_ADMIN_PORT:-8019}"
MGR_PORT="${MGR_PORT:-3300}"
AIRFLOW_PORT="${AIRFLOW_PORT:-8090}"

# ── 网关注册 ID / 凭据 / 租户（.env 提供；缺则空，探活 fail-closed）──
GW_ID="${GW_ID:-}"
GW_ADMIN_USER="${GW_ADMIN_USER:-}"
GW_ADMIN_PASSWORD="${GW_ADMIN_PASSWORD:-}"
MGR_ADMIN_USER="${MGR_ADMIN_USER:-}"
MGR_ADMIN_PASSWORD="${MGR_ADMIN_PASSWORD:-}"
TENANT_ID="${TENANT_ID:-}"
TENANT_TOKEN="${TENANT_TOKEN:-}"

# ── 二进制：优先 PATH 探测，探测不到回退 .env 显式路径 ──
PSQL="${PSQL:-$(command -v psql 2>/dev/null || true)}"
REDIS_CLI="${REDIS_CLI:-$(command -v redis-cli 2>/dev/null || true)}"

# ── 业务库 URL（从 plane api .env 提取，不硬编码）──
# 取最后一行：api .env 里 .env.example 基底带一个未展开的 ${POSTGRES_*} 模板
# DATABASE_URL，gen-env.sh 生成段在末尾再写一行具体值——tail 拿到具体值。
DB_URL="${DB_URL:-$(grep -E '^DATABASE_URL=' "$API_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2-)}"

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
