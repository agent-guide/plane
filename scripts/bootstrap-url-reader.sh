#!/bin/bash
# url_reader（链接解析 MCP 工具）平台链一键引导 —— 目标机本地执行，幂等可重放。
# 设计 docs/v2/link-and-file-artifacts-design.md §一。
#
#   bash scripts/bootstrap-url-reader.sh [--check]
#
# 前置：url-mcp 服务已跑（默认 http://127.0.0.1:8624，工具 url_reader）。
# 注意：与 plane-supplements 不同，本工具是 MCP stdio/streamable 服务——
# 网关侧注册为 mcp 连接器（type:mcp，transport:streamable_http）。
set -euo pipefail

CHECK_ONLY="${1:-}"
AGWMNGR="${AGWMNGR:-http://127.0.0.1:3300}"
GW_ID="${GW_ID:-agw-local}"
TENANT="${TENANT:-orch-v2}"
ADMIN_USER="${ADMIN_USER:-v2admin}"
ADMIN_PASS="${ADMIN_PASS:-OrchV2Admin!}"
MCP_URL="${MCP_URL:-http://127.0.0.1:8624}"

api() { curl -sf -H "Authorization: Bearer $TOKEN" "$@"; }
jsonget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)" 2>/dev/null; }
status() { echo "  [$1] $2"; }

# 探活 MCP 服务
curl -sf "$MCP_URL/health" >/dev/null \
  || { echo "FAIL: url-mcp 未探活（$MCP_URL/health）——先启动服务"; exit 1; }
status "OK" "url-mcp 探活 $MCP_URL"

TOKEN=$(curl -sf -X POST "$AGWMNGR/api/admin/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASS\"}" | jsonget "d['token']") \
  || { echo "FAIL: agwmngr 登录失败"; exit 1; }

# ── ① 网关 MCP 连接器 url-reader ──────────────────────────────────────
echo "① 网关 MCP 连接器 url-reader $MCP_URL"
CONN_LIST=$(api "$AGWMNGR/api/platform/v1/gateways/$GW_ID/infrastructure/connectors" || echo '{"items":[]}')
HAVE_CONN=$(echo "$CONN_LIST" | jsonget "str(any(c.get('id')=='url-reader' for c in d.get('items',[]))).lower()")
if [ "$HAVE_CONN" = "true" ]; then
  status "OK" "已存在"
else
  if [ -n "$CHECK_ONLY" ]; then status "MISS" "连接器未注册"; else
    cat > /tmp/url-reader-conn.json <<EOF
{"id":"url-reader","name":"URL reader (fetch web content)","type":"mcp","mcp":{
 "transport":"streamable_http","url":"$MCP_URL"}}
EOF
    api -X POST -H "Content-Type: application/json" \
      "$AGWMNGR/api/platform/v1/gateways/$GW_ID/infrastructure/connectors" \
      -d @/tmp/url-reader-conn.json >/dev/null && status "OK" "已注册" \
      || { status "FAIL" "注册失败（看 agwmngr 响应）"; exit 1; }
  fi
fi

# ── ② 平台目录 offering + 审批 ───────────────────────────────────────
echo "② 目录 offering（mcp:url-reader:url_reader）"
STABLE_ID="mcp:url-reader:url_reader"
OFF_LIST=$(api "$AGWMNGR/api/platform/v1/catalog/offerings?category=tool" || echo '{"items":[]}')
OFF_ID=$(echo "$OFF_LIST" | jsonget "next((o['offeringId'] for o in d.get('items',[]) if o.get('upstreamStableId')=='$STABLE_ID'), '')")
if [ -n "$OFF_ID" ]; then
  status "OK" "已登记（${OFF_ID}）"
else
  if [ -n "$CHECK_ONLY" ]; then status "MISS" "目录未登记"; else
    RES=$(api -X POST -H "Content-Type: application/json" "$AGWMNGR/api/platform/v1/catalog/offerings" \
      -d "{\"category\":\"tool\",\"name\":\"url_reader\",\"description\":\"Read web page text content from a URL (SSRF-guarded, size/timeout limited)\",\"kind\":\"gateway-backed\",\"source_gateway_id\":\"$GW_ID\",\"upstream_stable_id\":\"$STABLE_ID\",\"availability\":{\"mode\":\"tenant-allowlist\",\"tenant_ids\":[\"$TENANT\"]}}")
    OFF_ID=$(echo "$RES" | jsonget "d['offeringId']")
    api -X POST "$AGWMNGR/api/platform/v1/catalog/offerings/$OFF_ID/approve" >/dev/null \
      && status "OK" "已登记并审批（${OFF_ID}）" || { status "FAIL" "审批失败"; exit 1; }
  fi
fi
[ -n "$OFF_ID" ] || OFF_ID="(unknown)"

# ── ③ 租户工具定义 ───────────────────────────────────────────────────
echo "③ 租户工具定义（$TENANT / url_reader）"
TOOL_LIST=$(api "$AGWMNGR/api/platform/v1/tenants/$TENANT/tools" || echo '{"items":[]}')
HAVE_TOOL=$(echo "$TOOL_LIST" | jsonget "str(any(t.get('name')=='url_reader' for t in d.get('items',[]))).lower()")
if [ "$HAVE_TOOL" = "true" ]; then
  status "OK" "已存在"
else
  if [ -n "$CHECK_ONLY" ]; then status "MISS" "租户工具未创建"; else
    api -X POST -H "Content-Type: application/json" "$AGWMNGR/api/platform/v1/tenants/$TENANT/tools" \
      -d "{\"name\":\"url_reader\",\"description\":\"读取网页链接的文本内容（安全受限：内网拒绝、大小/超时限制）\",\"offering_id\":\"$OFF_ID\"}" >/dev/null \
      && status "OK" "已创建" || { status "FAIL" "创建失败"; exit 1; }
  fi
fi

# ── ④ 员工绑定报告（不自动改稿：release 不可变，改稿/部署需显式操作）────
echo "④ 员工绑定情况（release 快照 toolDefinitionIds 含 url_reader 工具 id）"
TOOL_ID=$(echo "$TOOL_LIST" | jsonget "next((t['id'] for t in d.get('items',[]) if t.get('name')=='url_reader'), '')")
AGENTS=$(api "$AGWMNGR/api/platform/v1/tenants/$TENANT/agents" | jsonget "','.join(a['id'] for a in d.get('items',[]))" 2>/dev/null || echo "")
for a in ${AGENTS//,/ }; do
  REL=$(api "$AGWMNGR/api/platform/v1/tenants/$TENANT/agents/$a/releases" \
    | jsonget "str(any('$TOOL_ID' in r.get('snapshot',{}).get('resources',{}).get('toolDefinitionIds',[]) for r in d.get('items',[]))).lower()" 2>/dev/null || echo unknown)
  [ "$REL" = "true" ] && status "OK" "${a}（已绑定）" || status "TODO" "${a}（改稿时勾选 url_reader）"
done

echo "── 完成。${CHECK_ONLY:+（--check 只读模式）}"
echo "  下一步：未绑定的员工 → 管理端改稿勾选 url_reader → 发布 release → 部署升级"
