#!/bin/bash
# 执行中补料（C8-B）配套一键引导 —— 目标机本地执行，幂等可重放。
#
# 部署纪律：产品能力依赖的配置随部署自动完成（配置即代码），杜绝
# "本地配了测试服没配"的环境遗漏。四步全部幂等：已存在且一致即跳过。
#
#   bash scripts/bootstrap-supplements.sh [--check]
#
# 环境变量（均有默认，本地/测试服皆宜）：
#   PLANE_BASE    Plane API 内部地址（agent 取补充的入口）默认 http://127.0.0.1:8001
#   AGWMNGR       agwmngr 地址   默认 http://127.0.0.1:4005
#   GW_ID         网关 ID        默认 gw-local（测试服 agw-main）
#   TENANT        租户 ID        默认 tenant-demo（测试服 orch-v2）
#   ADMIN_USER/PASS  agwmngr 平台管理员
#   GATEWAY_DIR   网关目录（改出站策略用）默认 /Users/shadow/Desktop/shu/agent-gateway
#   GATEWAY_UNIT  网关 systemd 单元名（服务器 agent-gateway）；空=本机 nohup 形态
set -euo pipefail

CHECK_ONLY="${1:-}"
PLANE_BASE="${PLANE_BASE:-http://127.0.0.1:8001}"
AGWMNGR="${AGWMNGR:-http://127.0.0.1:4005}"
GW_ID="${GW_ID:-gw-local}"
TENANT="${TENANT:-tenant-demo}"
ADMIN_USER="${ADMIN_USER:-localadmin}"
ADMIN_PASS="${ADMIN_PASS:-localdev123}"
GATEWAY_DIR="${GATEWAY_DIR:-/Users/shadow/Desktop/shu/agent-gateway}"
CADDYFILE="$GATEWAY_DIR/Caddyfile.experts"
POLICY_FILE="$GATEWAY_DIR/http-api-policy-local.json"

HOST_PORT=$(echo "$PLANE_BASE" | sed -E 's#https?://##')
HOST_ONLY=$(echo "$HOST_PORT" | cut -d: -f1)
PORT_ONLY=$(echo "$HOST_PORT" | cut -d: -f2)

api() { curl -sf -H "Authorization: Bearer $TOKEN" "$@"; }
jsonget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)" 2>/dev/null; }

TOKEN=$(curl -sf -X POST "$AGWMNGR/api/admin/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASS\"}" | jsonget "d['token']") \
  || { echo "FAIL: agwmngr 登录失败（$AGWMNGR）"; exit 1; }

status() { echo "  [$1] $2"; }

# ── ① 网关出站策略：回环放行 Plane 内部地址 ─────────────────────────────
echo "① 网关出站策略（回环 → $HOST_PORT）"
if [ ! -f "$CADDYFILE" ]; then
  status "SKIP" "未找到 $CADDYFILE（本步仅在有网关配置文件的环境执行）"
elif grep -q "http_api_policy_file" "$CADDYFILE" && [ -f "$POLICY_FILE" ] \
     && grep -qE "\"?$PORT_ONLY\"?" "$POLICY_FILE" 2>/dev/null; then
  status "OK" "已配置（policy 含端口 $PORT_ONLY）"
else
  if [ -n "$CHECK_ONLY" ]; then status "MISS" "缺 http_api_policy_file 或端口未放行"; else
    cp "$CADDYFILE" "$CADDYFILE.bak-$(date +%m%d)"
    grep -q "http_api_policy_file" "$CADDYFILE" || \
      sed -i.bak "s#^\(\s*\)agent_gateway {#\1agent_gateway {\n\1\thttp_api_policy_file ./http-api-policy-local.json#" "$CADDYFILE"
    cat > "$POLICY_FILE" <<EOF
{
  "version": 1,
  "default_action": "public_https",
  "rules": [
    {"action": "allow", "schemes": ["http"], "hosts": ["$HOST_ONLY"], "ports": [$PORT_ONLY], "cidrs": ["127.0.0.0/8"]}
  ],
  "limits": {"global_active": 128, "global_queued": 256, "connector_active": 16, "connector_queued": 32}
}
EOF
    if [ -n "${GATEWAY_UNIT:-}" ]; then sudo -n systemctl restart "$GATEWAY_UNIT"
    else kill $(pgrep -f "agw run") 2>/dev/null || true; sleep 2
         (cd "$GATEWAY_DIR" && export AGW_ADMIN_PASSWORD_HASH="${AGW_ADMIN_PASSWORD_HASH:?需 env AGW_ADMIN_PASSWORD_HASH}" \
          && nohup ./agw run --config Caddyfile.experts > /tmp/agw-run.log 2>&1 &)
    fi
    sleep 4
    curl -sf -o /dev/null http://127.0.0.1:8080/healthz && status "OK" "已写入并重启网关" || { status "FAIL" "网关未探活"; exit 1; }
  fi
fi

# ── ② 网关连接器 plane-supplements ────────────────────────────────────
echo "② 网关连接器 plane-supplements（base_url=$PLANE_BASE）"
CONN_LIST=$(api "$AGWMNGR/api/platform/v1/gateways/$GW_ID/infrastructure/connectors" || echo '{"items":[]}')
CONN_BASE=$(echo "$CONN_LIST" | jsonget "next((c.get('id') for c in d.get('items',[]) if c['id']=='plane-supplements'), '')")
if [ -n "$CONN_BASE" ]; then
  CUR_BASE=$(echo "$CONN_LIST" | jsonget "next(c.get('http_api',{}).get('base_url') for c in d.get('items',[]) if c['id']=='plane-supplements')")
  [ "$CUR_BASE" = "$PLANE_BASE" ] && status "OK" "已存在且 base_url 一致" \
    || status "WARN" "已存在但 base_url=$CUR_BASE ≠ $PLANE_BASE（请人工核对）"
else
  if [ -n "$CHECK_ONLY" ]; then status "MISS" "连接器未注册"; else
    cat > /tmp/plane-supplements-connector.json <<EOF
{"id":"plane-supplements","name":"Plane supplement query","type":"http_api","http_api":{
 "base_url":"$PLANE_BASE","auth":{"type":"none"},"timeout_ms":8000,"max_response_bytes":65536,
 "tools":[{"name":"fetch_supplements","description":"Query user supplements (messages) added during the current task execution. Call between stages to pick up new instructions.",
  "input_schema":{"type":"object","additionalProperties":false,"required":["execution_id","after","exp","sig"],
   "properties":{"execution_id":{"type":"string","minLength":1},"after":{"type":"string","description":"ISO 8601 timestamp from the prompt"},"exp":{"type":"string"},"sig":{"type":"string"}}},
  "request":{"method":"GET","path":"/api/internal/executions/{execution_id}/supplements/",
   "path_params":{"execution_id":{"argument":"execution_id"}},
   "query":{"after":{"argument":"after"},"exp":{"argument":"exp"},"sig":{"argument":"sig"}}}}]}}
EOF
    api -X POST -H "Content-Type: application/json" \
      "$AGWMNGR/api/platform/v1/gateways/$GW_ID/infrastructure/connectors" \
      -d @/tmp/plane-supplements-connector.json >/dev/null && status "OK" "已注册" \
      || { status "FAIL" "注册失败"; exit 1; }
  fi
fi

# ── ③ 平台目录 offering + 审批 ───────────────────────────────────────
echo "③ 平台目录 offering（connector:plane-supplements:fetch_supplements）"
STABLE_ID="connector:plane-supplements:fetch_supplements"
OFF_LIST=$(api "$AGWMNGR/api/platform/v1/catalog/offerings?category=tool" || echo '{"items":[]}')
OFF_ID=$(echo "$OFF_LIST" | jsonget "next((o['offeringId'] for o in d.get('items',[]) if o.get('upstreamStableId')=='$STABLE_ID'), '')")
if [ -n "$OFF_ID" ]; then
  status "OK" "已登记（offering $OFF_ID）"
else
  if [ -n "$CHECK_ONLY" ]; then status "MISS" "目录未登记"; else
    RES=$(api -X POST -H "Content-Type: application/json" "$AGWMNGR/api/platform/v1/catalog/offerings" \
      -d "{\"category\":\"tool\",\"name\":\"fetch_supplements\",\"description\":\"Query user supplements added during task execution\",\"kind\":\"gateway-backed\",\"source_gateway_id\":\"$GW_ID\",\"upstream_stable_id\":\"$STABLE_ID\",\"availability\":{\"mode\":\"tenant-allowlist\",\"tenant_ids\":[\"$TENANT\"]}}")
    OFF_ID=$(echo "$RES" | jsonget "d['offeringId']")
    api -X POST "$AGWMNGR/api/platform/v1/catalog/offerings/$OFF_ID/approve" >/dev/null \
      && status "OK" "已登记并审批（offering $OFF_ID）" || { status "FAIL" "审批失败"; exit 1; }
  fi
fi
[ -n "$OFF_ID" ] || OFF_ID="(unknown)"

# ── ④ 租户工具定义 ────────────────────────────────────────────────────
echo "④ 租户工具定义（$TENANT / fetch_supplements）"
TOOL_LIST=$(api "$AGWMNGR/api/platform/v1/tenants/$TENANT/tools" || echo '{"items":[]}')
HAVE_TOOL=$(echo "$TOOL_LIST" | jsonget "str(any(t.get('name')=='fetch_supplements' for t in d.get('items',[]))).lower()")
if [ "$HAVE_TOOL" = "true" ]; then
  status "OK" "已存在"
else
  if [ -n "$CHECK_ONLY" ]; then status "MISS" "租户工具未创建"; else
    api -X POST -H "Content-Type: application/json" "$AGWMNGR/api/platform/v1/tenants/$TENANT/tools" \
      -d "{\"name\":\"fetch_supplements\",\"description\":\"任务执行期间查询用户新补充的信息\",\"offering_id\":\"$OFF_ID\"}" >/dev/null \
      && status "OK" "已创建" || { status "FAIL" "创建失败"; exit 1; }
  fi
fi

# ── ⑤ 员工绑定报告（不自动改稿：release 不可变，改稿需人工/显式操作）────
echo "⑤ 员工绑定情况（release snapshot.toolDefinitionIds 含 fetch_supplements 工具 id）"
TOOL_ID=$(echo "$TOOL_LIST" | jsonget "next((t['id'] for t in d.get('items',[]) if t.get('name')=='fetch_supplements'), '')")
AGENTS=$(api "$AGWMNGR/api/platform/v1/tenants/$TENANT/agents" | jsonget "','.join(a['id'] for a in d.get('items',[]))" 2>/dev/null || echo "")
for a in ${AGENTS//,/ }; do
  REL=$(api "$AGWMNGR/api/platform/v1/tenants/$TENANT/agents/$a/releases" \
    | jsonget "str(any('$TOOL_ID' in r.get('snapshot',{}).get('resources',{}).get('toolDefinitionIds',[]) for r in d.get('items',[]))).lower()" 2>/dev/null || echo unknown)
  [ "$REL" = "true" ] && status "OK" "$a（已绑定）" || status "TODO" "$a（改稿时勾选 fetch_supplements）"
done

echo "── 完成。${CHECK_ONLY:+（--check 只读模式）}"
