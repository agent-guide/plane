#!/bin/bash
# request_human_input（链接解析 MCP 工具）平台链一键引导 —— 目标机本地执行，幂等可重放。
# 设计 docs 私有仓 agent-execution-protocol-endgame.md §二/§三。
#
#   bash scripts/bootstrap-platform-tools.sh [--check]
#
# 前置：platform-tools-mcp 服务已跑（默认 http://127.0.0.1:8626，工具 request_human_input）。
# 注意：与 plane-supplements 不同，本工具是 MCP stdio/streamable 服务——
# 网关侧注册为 mcp 连接器（type:mcp，transport:streamable_http）。
set -euo pipefail

CHECK_ONLY="${1:-}"
AGWMNGR="${AGWMNGR:-http://127.0.0.1:3300}"
GW_ID="${GW_ID:-agw-local}"
TENANT="${TENANT:-orch-v2}"
ADMIN_USER="${ADMIN_USER:-v2admin}"
ADMIN_PASS="${ADMIN_PASS:-OrchV2Admin!}"
MCP_URL="${MCP_URL:-http://127.0.0.1:8626}"

api() { curl -sf -H "Authorization: Bearer $TOKEN" "$@"; }
jsonget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)" 2>/dev/null; }
status() { echo "  [$1] $2"; }

# 探活 MCP 服务
curl -sf "$MCP_URL/health" >/dev/null \
  || { echo "FAIL: platform-tools-mcp 未探活（$MCP_URL/health）——先启动服务"; exit 1; }
status "OK" "platform-tools-mcp 探活 $MCP_URL"

TOKEN=$(curl -sf -X POST "$AGWMNGR/api/admin/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASS\"}" | jsonget "d['token']") \
  || { echo "FAIL: agwmngr 登录失败"; exit 1; }

# ── ① 网关 MCP 连接器 platform-tools ──────────────────────────────────────
echo "① 网关 MCP 连接器 platform-tools $MCP_URL"
CONN_LIST=$(api "$AGWMNGR/api/platform/v1/gateways/$GW_ID/infrastructure/connectors" || echo '{"items":[]}')
HAVE_CONN=$(echo "$CONN_LIST" | jsonget "str(any(c.get('id')=='platform-tools' for c in d.get('items',[]))).lower()")
if [ "$HAVE_CONN" = "true" ]; then
  status "OK" "已存在"
else
  if [ -n "$CHECK_ONLY" ]; then status "MISS" "连接器未注册"; else
    cat > /tmp/platform-tools-conn.json <<EOF
{"id":"platform-tools","name":"Platform tools (ask human / supplements)","type":"mcp","mcp":{
 "transport":"streamable_http","url":"$MCP_URL"}}
EOF
    api -X POST -H "Content-Type: application/json" \
      "$AGWMNGR/api/platform/v1/gateways/$GW_ID/infrastructure/connectors" \
      -d @/tmp/platform-tools-conn.json >/dev/null && status "OK" "已注册" \
      || { status "FAIL" "注册失败（看 agwmngr 响应）"; exit 1; }
  fi
fi

# ── ①b 网关私有 MCP 路由 ──────────────────────────────────────────────
# ACP 型 agent 的工具映射（acp-resource-directory）要求每个 connector 恰好一条
# require_virtual_key 私有路由；builtin 型不受影响但共用无妨。
echo "①b 网关私有 MCP 路由 /tools/platform-tools"
ROUTE_ID="mcp-platform-tools"; ROUTE_PATH="/tools/platform-tools"
ROUTES=$(api "$AGWMNGR/api/platform/v1/gateways/$GW_ID/infrastructure/mcp/routes" || echo '{"items":[]}')
HAVE_ROUTE=$(echo "$ROUTES" | jsonget "str(any(r.get('id')=='$ROUTE_ID' and (r.get('match_policy') or {}).get('path_prefix')=='$ROUTE_PATH' and (r.get('auth_policy') or {}).get('require_virtual_key') is True for r in d.get('items',[]))).lower()")
if [ "$HAVE_ROUTE" = "true" ]; then
  status "OK" "已存在"
elif [ -n "$CHECK_ONLY" ]; then
  status "MISS" "私有 MCP 路由未建（ACP 型 agent 挂工具的前置）"
else
  api -X POST -H "Content-Type: application/json" \
    "$AGWMNGR/api/platform/v1/gateways/$GW_ID/infrastructure/mcp/routes" \
    -d "{\"id\":\"$ROUTE_ID\",\"description\":\"platform-tools private route\",\"disabled\":false,\"connector_id\":\"platform-tools\",\"match_policy\":{\"path_prefix\":\"$ROUTE_PATH\"},\"auth_policy\":{\"require_virtual_key\":true}}" >/dev/null \
    && status "OK" "已建" || { status "FAIL" "路由创建失败"; exit 1; }
fi

# ── ② 平台目录 + ③ 租户工具（双工具：ask + supplements，收敛后单链）──
# request_supplements 票据制查询补充（2026-11-26 收敛定案）：
# 老的 connector:plane-supplements:fetch_supplements 双轨退役方向。
TOOL_DEFS="request_human_input|Request human input (blocking ask)|平台工具：请求人工输入（阻塞等待答复）
request_supplements|Query task supplements by ticket|平台工具：票据查询执行中补充资料"
OFF_LIST=$(api "$AGWMNGR/api/platform/v1/catalog/offerings?category=tool" || echo '{"items":[]}')
TOOL_LIST=$(api "$AGWMNGR/api/platform/v1/tenants/$TENANT/tools" || echo '{"items":[]}')
while IFS='|' read -r TNAME TDESC_ZH_EN TDESC_ZH; do
  STABLE_ID="mcp:platform-tools:$TNAME"
  echo "② 目录 offering（$STABLE_ID）"
  OFF_ID=$(echo "$OFF_LIST" | jsonget "next((o['offeringId'] for o in d.get('items',[]) if o.get('upstreamStableId')=='$STABLE_ID'), '')")
  if [ -n "$OFF_ID" ]; then
    status "OK" "已登记（${OFF_ID}）"
    api -X PUT -H "Content-Type: application/json" "$AGWMNGR/api/platform/v1/catalog/offerings/$OFF_ID/availability" \
      -d "{\"tenant_ids\":[\"$TENANT\"]}" >/dev/null 2>&1 || true
  else
    if [ -n "$CHECK_ONLY" ]; then status "MISS" "目录未登记"; else
      RES=$(api -X POST -H "Content-Type: application/json" "$AGWMNGR/api/platform/v1/catalog/offerings" \
        -d "{\"category\":\"tool\",\"name\":\"$TNAME\",\"description\":\"$TDESC_ZH_EN\",\"kind\":\"gateway-backed\",\"source_gateway_id\":\"$GW_ID\",\"upstream_stable_id\":\"$STABLE_ID\",\"availability\":{\"tenant_ids\":[\"$TENANT\"]}}")
      OFF_ID=$(echo "$RES" | jsonget "d['offeringId']")
      [ -n "$OFF_ID" ] || { status "FAIL" "登记失败"; exit 1; }
      status "OK" "已登记（${OFF_ID}，创建即生效）"
    fi
  fi
  echo "③ 租户工具定义（$TENANT / $TNAME）"
  HAVE_TOOL=$(echo "$TOOL_LIST" | jsonget "str(any(t.get('name')=='$TNAME' for t in d.get('items',[]))).lower()")
  if [ "$HAVE_TOOL" = "true" ]; then
    status "OK" "已存在"
  else
    if [ -n "$CHECK_ONLY" ]; then status "MISS" "租户工具未创建"; else
      api -X POST -H "Content-Type: application/json" "$AGWMNGR/api/platform/v1/tenants/$TENANT/tools" \
        -d "{\"name\":\"$TNAME\",\"description\":\"$TDESC_ZH\",\"offering_id\":\"$OFF_ID\"}" >/dev/null \
        && status "OK" "已创建" || { status "FAIL" "创建失败"; exit 1; }
    fi
  fi
done <<< "$TOOL_DEFS"

# ── ④ 员工绑定报告（不自动改稿：release 不可变，改稿/部署需显式操作）────
echo "④ 员工绑定情况（release 快照 toolDefinitionIds 含 request_human_input 工具 id）"
TOOL_ID=$(echo "$TOOL_LIST" | jsonget "next((t['id'] for t in d.get('items',[]) if t.get('name')=='request_human_input'), '')")
AGENTS=$(api "$AGWMNGR/api/platform/v1/tenants/$TENANT/agents" | jsonget "','.join(a['id'] for a in d.get('items',[]))" 2>/dev/null || echo "")
for a in ${AGENTS//,/ }; do
  REL=$(api "$AGWMNGR/api/platform/v1/tenants/$TENANT/agents/$a/releases" \
    | jsonget "str(any('$TOOL_ID' in r.get('snapshot',{}).get('resources',{}).get('toolDefinitionIds',[]) for r in d.get('items',[]))).lower()" 2>/dev/null || echo unknown)
  [ "$REL" = "true" ] && status "OK" "${a}（已绑定）" || status "TODO" "${a}（改稿时勾选 request_human_input）"
done

echo "── 完成。${CHECK_ONLY:+（--check 只读模式）}"
echo "  下一步：未绑定的员工 → 管理端改稿勾选 request_human_input → 发布 release → 部署升级"
