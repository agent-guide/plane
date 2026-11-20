#!/bin/bash
# parse_document（文档解析 MCP 工具）平台链一键引导 —— 目标机本地执行，幂等可重放。
# 设计 docs/v2/document-parsing-and-email-capability.md §二/§四。
#
#   bash scripts/bootstrap-doc-parser.sh [--check]
#
# 前置：doc-mcp 服务已跑（默认 http://127.0.0.1:8625，工具 parse_document）。
# 定位：agent 主动解析兜底（用户上传附件走平台自动注入，不依赖本工具）。
set -euo pipefail

CHECK_ONLY="${1:-}"
AGWMNGR="${AGWMNGR:-http://127.0.0.1:3300}"
GW_ID="${GW_ID:-agw-local}"
TENANT="${TENANT:-orch-v2}"
ADMIN_USER="${ADMIN_USER:-v2admin}"
ADMIN_PASS="${ADMIN_PASS:-OrchV2Admin!}"
MCP_URL="${MCP_URL:-http://127.0.0.1:8625}"

api() { curl -sf -H "Authorization: Bearer $TOKEN" "$@"; }
jsonget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)" 2>/dev/null; }
status() { echo "  [$1] $2"; }

curl -sf "$MCP_URL/health" >/dev/null \
  || { echo "FAIL: doc-mcp 未探活（$MCP_URL/health）——先启动服务"; exit 1; }
status "OK" "doc-mcp 探活 $MCP_URL"

TOKEN=$(curl -sf -X POST "$AGWMNGR/api/admin/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASS\"}" | jsonget "d['token']") \
  || { echo "FAIL: agwmngr 登录失败"; exit 1; }

# ── ① 网关 MCP 连接器 doc-parser ──────────────────────────────────────
echo "① 网关 MCP 连接器 doc-parser $MCP_URL"
CONN_LIST=$(api "$AGWMNGR/api/platform/v1/gateways/$GW_ID/infrastructure/connectors" || echo '{"items":[]}')
HAVE_CONN=$(echo "$CONN_LIST" | jsonget "str(any(c.get('id')=='doc-parser' for c in d.get('items',[]))).lower()")
if [ "$HAVE_CONN" = "true" ]; then
  status "OK" "已存在"
else
  if [ -n "$CHECK_ONLY" ]; then status "MISS" "连接器未注册"; else
    cat > /tmp/doc-parser-conn.json <<EOF
{"id":"doc-parser","name":"Document parser (parse documents to text)","type":"mcp","mcp":{
 "transport":"streamable_http","url":"$MCP_URL"}}
EOF
    api -X POST -H "Content-Type: application/json" \
      "$AGWMNGR/api/platform/v1/gateways/$GW_ID/infrastructure/connectors" \
      -d @/tmp/doc-parser-conn.json >/dev/null && status "OK" "已注册" \
      || { status "FAIL" "注册失败（看 agwmngr 响应）"; exit 1; }
  fi
fi

# ── ①b 网关私有 MCP 路由 ──────────────────────────────────────────────
# ACP 型 agent 的工具映射（acp-resource-directory）要求每个 connector 恰好一条
# require_virtual_key 私有路由；builtin 型不受影响但共用无妨。
echo "①b 网关私有 MCP 路由 /tools/doc-parser"
ROUTE_ID="mcp-doc-parser"; ROUTE_PATH="/tools/doc-parser"
ROUTES=$(api "$AGWMNGR/api/platform/v1/gateways/$GW_ID/infrastructure/mcp/routes" || echo '{"items":[]}')
HAVE_ROUTE=$(echo "$ROUTES" | jsonget "str(any(r.get('id')=='$ROUTE_ID' and (r.get('match_policy') or {}).get('path_prefix')=='$ROUTE_PATH' and (r.get('auth_policy') or {}).get('require_virtual_key') is True for r in d.get('items',[]))).lower()")
if [ "$HAVE_ROUTE" = "true" ]; then
  status "OK" "已存在"
elif [ -n "$CHECK_ONLY" ]; then
  status "MISS" "私有 MCP 路由未建（ACP 型 agent 挂工具的前置）"
else
  api -X POST -H "Content-Type: application/json" \
    "$AGWMNGR/api/platform/v1/gateways/$GW_ID/infrastructure/mcp/routes" \
    -d "{\"id\":\"$ROUTE_ID\",\"description\":\"doc-parser private route\",\"disabled\":false,\"connector_id\":\"doc-parser\",\"match_policy\":{\"path_prefix\":\"$ROUTE_PATH\"},\"auth_policy\":{\"require_virtual_key\":true}}" >/dev/null \
    && status "OK" "已建" || { status "FAIL" "路由创建失败"; exit 1; }
fi

# ── ② 平台目录 offering + 审批 ───────────────────────────────────────
echo "② 目录 offering（mcp:doc-parser:parse_document）"
STABLE_ID="mcp:doc-parser:parse_document"
OFF_LIST=$(api "$AGWMNGR/api/platform/v1/catalog/offerings?category=tool" || echo '{"items":[]}')
OFF_ID=$(echo "$OFF_LIST" | jsonget "next((o['offeringId'] for o in d.get('items',[]) if o.get('upstreamStableId')=='$STABLE_ID'), '')")
if [ -n "$OFF_ID" ]; then
  status "OK" "已登记（${OFF_ID}）"
else
  if [ -n "$CHECK_ONLY" ]; then status "MISS" "目录未登记"; else
    RES=$(api -X POST -H "Content-Type: application/json" "$AGWMNGR/api/platform/v1/catalog/offerings" \
      -d "{\"category\":\"tool\",\"name\":\"parse_document\",\"description\":\"Parse document content (pdf/docx/xlsx/pptx/html/text) to plain text\",\"kind\":\"gateway-backed\",\"source_gateway_id\":\"$GW_ID\",\"upstream_stable_id\":\"$STABLE_ID\",\"availability\":{\"mode\":\"tenant-allowlist\",\"tenant_ids\":[\"$TENANT\"]}}")
    OFF_ID=$(echo "$RES" | jsonget "d['offeringId']")
    api -X POST "$AGWMNGR/api/platform/v1/catalog/offerings/$OFF_ID/approve" >/dev/null \
      && status "OK" "已登记并审批（${OFF_ID}）" || { status "FAIL" "审批失败"; exit 1; }
  fi
fi
[ -n "$OFF_ID" ] || OFF_ID="(unknown)"

# ── ③ 租户工具定义 ───────────────────────────────────────────────────
echo "③ 租户工具定义（$TENANT / parse_document）"
TOOL_LIST=$(api "$AGWMNGR/api/platform/v1/tenants/$TENANT/tools" || echo '{"items":[]}')
HAVE_TOOL=$(echo "$TOOL_LIST" | jsonget "str(any(t.get('name')=='parse_document' for t in d.get('items',[]))).lower()")
if [ "$HAVE_TOOL" = "true" ]; then
  status "OK" "已存在"
else
  if [ -n "$CHECK_ONLY" ]; then status "MISS" "租户工具未创建"; else
    api -X POST -H "Content-Type: application/json" "$AGWMNGR/api/platform/v1/tenants/$TENANT/tools" \
      -d "{\"name\":\"parse_document\",\"description\":\"把文档（pdf/docx/xlsx/pptx/html/md/csv 等）解析成纯文本——仅当工具返回了未解析的文档内容（如邮件附件）时调用；用户上传的附件已自动注入，不需要调用\",\"offering_id\":\"$OFF_ID\"}" >/dev/null \
      && status "OK" "已创建" || { status "FAIL" "创建失败"; exit 1; }
  fi
fi

# ── ④ 员工绑定报告（不自动改稿：release 不可变，改稿/部署需显式操作）────
echo "④ 员工绑定情况（release 快照 toolDefinitionIds 含 parse_document 工具 id）"
TOOL_ID=$(echo "$TOOL_LIST" | jsonget "next((t['id'] for t in d.get('items',[]) if t.get('name')=='parse_document'), '')")
AGENTS=$(api "$AGWMNGR/api/platform/v1/tenants/$TENANT/agents" | jsonget "','.join(a['id'] for a in d.get('items',[]))" 2>/dev/null || echo "")
for a in ${AGENTS//,/ }; do
  REL=$(api "$AGWMNGR/api/platform/v1/tenants/$TENANT/agents/$a/releases" \
    | jsonget "str(any('$TOOL_ID' in r.get('snapshot',{}).get('resources',{}).get('toolDefinitionIds',[]) for r in d.get('items',[]))).lower()" 2>/dev/null || echo unknown)
  [ "$REL" = "true" ] && status "OK" "${a}（已绑定）" || status "TODO" "${a}（改稿时勾选 parse_document）"
done

echo "── 完成。${CHECK_ONLY:+（--check 只读模式）}"
echo "  下一步：未绑定的员工 → 管理端改稿勾选 parse_document → 发布 release → 部署升级"
