#!/bin/bash
# 平台链一键开通（幂等可重放；bootstrap-supplements.sh 同款纪律）：
#   网关注册 → 租户 → 服务主体(admin) → 网关授权 → LLM offering/租户模型
#   → builtin 员工 → release → deployment(key-binding+apply) → 回填 plane env
# 前置：up.sh 全绿（gateway/agwmngr/api 在跑）。LLM_API_KEY 未配则跳过模型链
#（流程退化为纯人工节点，agwmngr 侧仍可后续手配）。
set -euo pipefail
cd "$(dirname "$0")"
source lib/common.sh
GW_ID=agw-local
MGR="http://127.0.0.1:$MGR_PORT"
set -a; source .env; set +a

jget() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)" 2>/dev/null; }
mgr() { # mgr <方法> <路径> [JSON] —— 平台管理员 token
  local m=$1 p=$2 d=${3:-}
  local args=(-s -X "$m" "$MGR$p" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json')
  [ -n "$d" ] && args+=(-d "$d")
  curl -sf "${args[@]}"
}

step "① 管理员会话"
ADMIN_TOKEN="$(curl -sf -X POST "$MGR/api/admin/auth/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$MGR_ADMIN_USER\",\"password\":\"$MGR_ADMIN_PASSWORD\"}" | jget "d['token']")" \
  || fail "agwmngr 登录失败（${MGR}）"

step "② 网关注册（$GW_ID → :${GW_ADMIN_PORT}）"
if mgr GET "/api/admin/gateways/$GW_ID" >/dev/null 2>&1; then ok "已注册"; else
  mgr POST /api/admin/gateways "{\"id\":\"$GW_ID\",\"name\":\"本地网关\",\"admin_addr\":\"http://localhost:$GW_ADMIN_PORT\",\"admin_user\":\"$GW_ADMIN_USER\",\"admin_password\":\"$GW_ADMIN_PASSWORD\",\"dataplane_addr\":\"http://127.0.0.1:$GW_DATA_PORT\",\"caddy_admin_addr\":\"http://127.0.0.1:$GW_CADDY_ADMIN_PORT\"}" >/dev/null
  ok "已注册"; fi
TEST_OK=$(mgr POST "/api/admin/gateways/$GW_ID/test" '{}' | jget "d.get('ok')") || TEST_OK=""
[ "$TEST_OK" = "True" ] && ok "网关连通测试通过" || fail "网关连通测试未通过（地址/口令核对 Caddyfile.local）"

step "③ 租户 + 服务主体"
mgr POST /api/platform/v1/identity/tenants "{\"id\":\"$TENANT_ID\",\"name\":\"$TENANT_ID 本地租户\"}" >/dev/null 2>&1 && ok "租户已建" || ok "租户已存在"
TENANT_TOKEN="${TENANT_TOKEN:-}"
SVC="service:$TENANT_SVC_NAME"
if [ -z "$TENANT_TOKEN" ] && ! mgr GET "/api/platform/v1/tenants/$TENANT_ID/agents" -H x >/dev/null 2>&1; then :; fi
# 幂等：主体已存在则复用（token 只在创建时返回一次，落 .env）
if grep -q '^TENANT_TOKEN=' .env; then
  set -a; source .env; set +a; ok "复用既有服务令牌"; else
  R=$(mgr POST /api/platform/v1/identity/service-principals \
    "{\"name\":\"$TENANT_SVC_NAME\",\"tenant_id\":\"$TENANT_ID\",\"role\":\"admin\",\"expires_at\":\"2027-12-31T00:00:00Z\"}") \
    || fail "服务主体创建失败（可能已存在但 .env 丢了 token——agwmngr 侧删主体后重跑）"
  TENANT_TOKEN=$(echo "$R" | jget "d['token']")
  echo "TENANT_TOKEN=$TENANT_TOKEN" >> .env
  ok "服务主体 $SVC 已建"; fi
mgr PUT /api/platform/v1/identity/tenant-gateway-grants \
  "{\"principal_id\":\"$SVC\",\"tenant_id\":\"$TENANT_ID\",\"gateway_id\":\"$GW_ID\",\"access\":\"manage\"}" >/dev/null \
  && ok "网关 manage 授权完成"
tt() { curl -sf -H "Authorization: Bearer $TENANT_TOKEN" "$MGR$1" "${@:2}"; }

step "④ LLM 路由与模型链（真实上游）"
if [ "${LLM_API_KEY:-__SET_ME__}" = "__SET_ME__" ]; then
  miss "LLM_API_KEY 未配置 —— 跳过模型/员工链（后续补填后重跑本脚本）"
else
  GWU="http://localhost:$GW_ADMIN_PORT"; GU=(-u "$GW_ADMIN_USER:$GW_ADMIN_PASSWORD")
  curl -sf "${GU[@]}" "$GWU/admin/llm/providers/$LLM_PROVIDER_ID" >/dev/null 2>&1 || \
    curl -sf "${GU[@]}" -X POST "$GWU/admin/llm/providers" -H 'Content-Type: application/json' \
      -d "{\"id\":\"$LLM_PROVIDER_ID\",\"provider_type\":\"$LLM_PROVIDER_TYPE\",\"api_key\":\"$LLM_API_KEY\",\"base_url\":\"$LLM_BASE_URL\",\"default_model\":\"$LLM_MODEL\"}" >/dev/null
  curl -sf "${GU[@]}" -X POST "$GWU/admin/llm/models/provider" -H 'Content-Type: application/json' \
    -d "{\"provider_id\":\"$LLM_PROVIDER_ID\",\"upstream_model\":\"$LLM_MODEL\"}" >/dev/null 2>&1 || true
  curl -sf "${GU[@]}" -X PUT "$GWU/admin/llm/models/provider/$LLM_PROVIDER_ID/$LLM_MODEL" -H 'Content-Type: application/json' \
    -d "{\"provider_id\":\"$LLM_PROVIDER_ID\",\"upstream_model\":\"$LLM_MODEL\",\"enabled\":true}" >/dev/null
  curl -sf "${GU[@]}" -X PUT "$GWU/admin/llm/routes/chat-main" -H 'Content-Type: application/json' -d @- >/dev/null <<EOF
{"id":"chat-main","protocol":"openai","match_policy":{"path_prefix":"/llm","methods":["POST"]},
 "target_policy":{"type":"models","default_model":"$LLM_MODEL",
   "model_targets":[{"name":"$LLM_MODEL","kind":"provider-model","provider_id":"$LLM_PROVIDER_ID","upstream_model":"$LLM_MODEL"}]},
 "auth_policy":{"require_virtual_key":true}}
EOF
  ok "chat-main → $LLM_PROVIDER_ID/${LLM_MODEL}（注意：改 target 后需重启 agw 才对 builtin agent 生效）"

  step "⑤ 目录 → 租户模型 → 员工 → 部署"
  OFF=$(mgr GET /api/platform/v1/catalog/offerings | jget "next((o['offeringId'] for o in (d.get('items',d)) if o.get('upstreamStableId')=='chat-main'),'')" )
  [ -n "$OFF" ] || OFF=1
  mgr GET "/api/platform/v1/catalog/offerings/$OFF" >/dev/null 2>&1 || \
    mgr POST /api/platform/v1/catalog/offerings "{\"category\":\"model\",\"kind\":\"gateway-backed\",\"name\":\"chat-main model\",\"description\":\"local\",\"source_gateway_id\":\"$GW_ID\",\"upstream_stable_id\":\"chat-main\",\"availability\":{\"mode\":\"tenant-allowlist\",\"tenant_ids\":[\"$TENANT_ID\"]}}" >/dev/null
  mgr POST "/api/platform/v1/catalog/offerings/$OFF/approve" '' >/dev/null 2>&1 || true
  MID=$(tt "/api/platform/v1/tenants/$TENANT_ID/models" | jget "d['items'][0]['id']") || MID=""
  if [ -z "$MID" ]; then
    MID=$(tt -X POST "/api/platform/v1/tenants/$TENANT_ID/models" -H 'Content-Type: application/json' \
      -d "{\"name\":\"主模型\",\"description\":\"local\",\"offering_id\":\"$OFF\"}" | jget "d['id']") || fail "租户模型创建失败"
  fi
  AGENT="agent:$TENANT_ID:chat-employee"
  if ! tt "/api/platform/v1/tenants/$TENANT_ID/agents" | grep -q chat-employee; then
    tt -X POST "/api/platform/v1/tenants/$TENANT_ID/agents" -H 'Content-Type: application/json' -d @- >/dev/null <<EOF
{"slug":"chat-employee","expected_version":0,"draft":{"name":"通关助手","description":"报关草稿生成",
 "systemPrompt":"你是报关助手，负责根据卡片内容生成报关单草稿。",
 "runtime":{"type":"builtin","advanced":{"topology":{"kind":"single"}}},
 "resources":{"modelDefinitionId":"$MID","toolDefinitionIds":[],"skillVersions":[],"instructionVersions":[],"knowledgeBaseIds":[]},"policy":{}}}
EOF
    ok "员工定义已建"; else ok "员工定义已存在"; fi
  REL=$(tt "/api/platform/v1/tenants/$TENANT_ID/agents/$AGENT/releases" | jget "d['items'][-1]['number']") || REL=""
  if [ -z "$REL" ]; then
    REL=$(tt -X POST "/api/platform/v1/tenants/$TENANT_ID/agents/$AGENT/releases" -H 'Content-Type: application/json' \
      -d '{"expected_version":1}' | jget "d['number']") || fail "release 发布失败"
    ok "release $REL 已发布"; else ok "release $REL 复用"; fi
  DPID=$(tt "/api/platform/v1/tenants/$TENANT_ID/deployments" | jget "next((x['id'] for x in d['items'] if x['lifecycleState']=='active'),'')")
  if [ -z "$DPID" ]; then
    DPID=$(tt -X POST "/api/platform/v1/tenants/$TENANT_ID/deployments" -H 'Content-Type: application/json' \
      -d "{\"definition_id\":\"$AGENT\",\"release_number\":$REL,\"gateway_id\":\"$GW_ID\",\"request_key\":\"local-chat-1\"}" | jget "d['id']") || fail "部署意图创建失败"
    tt -X POST "/api/platform/v1/tenants/$TENANT_ID/deployments/$DPID/key-binding" -H 'Content-Type: application/json' -d '{}' >/dev/null || fail "key-binding 失败"
    tt -X POST "/api/platform/v1/tenants/$TENANT_ID/deployments/$DPID/apply" -H 'Content-Type: application/json' \
      -d '{"request_key":"local-chat-apply-1"}' >/dev/null || fail "apply 失败"
    sleep 3
    ST=$(tt "/api/platform/v1/tenants/$TENANT_ID/deployments/$DPID" | jget "d['lifecycleState']")
    [ "$ST" = "active" ] && ok "部署已 active" || fail "部署状态 ${ST}（未收敛）"
  else ok "部署已 active，复用"; fi
fi

step "⑥ url_reader 平台链（连接器 → offering → 租户工具，幂等）"
# 工具侧路线（link-and-file-artifacts-design §一）：url-mcp 服务由 up.sh ③ 拉起，
# 这里只做网关注册与目录登记；员工绑定是改稿动作，脚本仅报告（bootstrap ④）
bash ../bootstrap-platform-tools.sh || fail "platform-tools 平台链注册失败（platform-tools-mcp 是否在跑？up.sh ③b）"
bash ../bind-platform-tools.sh || fail "存量员工绑定平台工具失败（看上方日志）"
bash ../bootstrap-url-reader.sh || fail "url_reader 平台链注册失败（url-mcp 是否在跑？up.sh ③）"
bash ../bootstrap-doc-parser.sh || fail "parse_document 平台链注册失败（doc-mcp 是否在跑？up.sh ④）"

step "⑦ 回填 plane api env（AGWMNGR_*）"
grep -v '^AGWMNGR_TENANT_TOKEN=\|^AGWMNGR_TENANT_ID=' "$API_DIR/.env" > "$API_DIR/.env.n" && mv "$API_DIR/.env.n" "$API_DIR/.env"
cat >> "$API_DIR/.env" <<EOF
AGWMNGR_TENANT_TOKEN=$TENANT_TOKEN
AGWMNGR_TENANT_ID=$TENANT_ID
EOF
ok "已回填（改了 env 须重启 api/worker：down.sh && up.sh，或先 --skip 平台链验证基础栈）"
echo; echo "✅ provision 完成。验证：bash scripts/local/smoke.sh"
