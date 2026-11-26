#!/usr/bin/env bash
# 存量员工批量绑定全部工具（幂等可重放）—— 过渡期方案。
# 绑定清单：platform-tools（ask/supplements）+ url_reader + parse_document。
# 同事侧物化注入（feature/platform-tools-injection）合并后，platform-tools 部分自动 no-op。
#
#   bash scripts/bind-platform-tools.sh
#
# 逻辑：遍历租户员工 → 未绑则改稿（toolDefinitionIds += request_human_input）
#       → 发布 release → 升级部署。已绑/无部署的跳过。
set -euo pipefail
AGWMNGR="${AGWMNGR:-http://127.0.0.1:3300}"
GW_ID="${GW_ID:-agw-local}"
TENANT="${TENANT:-orch-v2}"
ADMIN_USER="${ADMIN_USER:-v2admin}"
ADMIN_PASS="${ADMIN_PASS:-OrchV2Admin!}"
api() { curl -sf -H "Authorization: Bearer $TOKEN" "$@"; }
jsonget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)" 2>/dev/null; }
status() { echo "  [$1] $2"; }
TOKEN=$(curl -sf -X POST "$AGWMNGR/api/admin/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASS\"}" | jsonget "d['token']") \
  || { echo "FAIL: agwmngr 登录失败"; exit 1; }
# 工具 id（三个：platform-tools 的 ask + url_reader + parse_document）
TOOL_IDS=""
for TNAME in request_human_input request_supplements url_reader parse_document; do
  TID=$(api "$AGWMNGR/api/platform/v1/tenants/$TENANT/tools" \
    | jsonget "next((t['id'] for t in d.get('items',[]) if t.get('name')=='$TNAME'), '')")
  if [ -z "$TID" ]; then
    echo "  [WARN] 工具 $TNAME 不存在——先跑对应 bootstrap 脚本；跳过此工具"
  else
    TOOL_IDS="$TOOL_IDS $TID"
    status "OK" "工具 $TNAME → $TID"
  fi
done
[ -n "$TOOL_IDS" ] || { echo "FAIL: 无任何工具可绑定"; exit 1; }
# 遍历员工
AGENTS=$(api "$AGWMNGR/api/platform/v1/tenants/$TENANT/agents" | jsonget "','.join(a['id'] for a in d.get('items',[]))")
BOUND=0; SKIPPED=0; FAILED=0
for a in ${AGENTS//,/ }; do
  DETAIL=$(api "$AGWMNGR/api/platform/v1/tenants/$TENANT/agents/$a")
  VER=$(echo "$DETAIL" | jsonget "d['version']")
  # 检查是否全部已绑定
  ALL_BOUND=$(echo "$DETAIL" | python3 -c "
import json,sys
d = json.load(sys.stdin)
bound = set(d.get('draft',{}).get('resources',{}).get('toolDefinitionIds',[]))
want = '$TOOL_IDS'.split()
missing = [t for t in want if t not in bound]
print('true' if not missing else 'false')")
  if [ "$ALL_BOUND" = "true" ]; then
    SKIPPED=$((SKIPPED+1)); status "SKIP" "$a（已全部绑定）"; continue; fi
  # 改稿（追加缺失的工具，幂等）
  DRAFT=$(echo "$DETAIL" | python3 -c "
import json,sys
d = json.load(sys.stdin)
draft = d['draft']
tools = draft['resources']['toolDefinitionIds']
for tid in '$TOOL_IDS'.split():
    if tid not in tools: tools.append(tid)
print(json.dumps(draft))")
  api -X PUT "$AGWMNGR/api/platform/v1/tenants/$TENANT/agents/$a" \
    -H "Content-Type: application/json" \
    -d "{\"expected_version\": $VER, \"draft\": $DRAFT}" >/dev/null || { FAILED=$((FAILED+1)); status "FAIL" "$a（改稿）"; continue; }
  # 发布
  VER2=$(api "$AGWMNGR/api/platform/v1/tenants/$TENANT/agents/$a" | jsonget "d['version']")
  REL=$(api -X POST "$AGWMNGR/api/platform/v1/tenants/$TENANT/agents/$a/releases" \
    -H "Content-Type: application/json" \
    -d "{\"expected_version\": $VER2}" | jsonget "d.get('number','')")
  [ -n "$REL" ] || { FAILED=$((FAILED+1)); status "FAIL" "$a（发布）"; continue; }
  # 升级 active 部署（如有）
  DEPS=$(api "$AGWMNGR/api/platform/v1/tenants/$TENANT/deployments" | jsonget "','.join(x['id'] for x in d.get('items',[]) if x.get('definitionId')=='$a' and str(x.get('lifecycleState','')).lower()=='active')")
  if [ -n "$DEPS" ]; then
    for dep in ${DEPS//,/ }; do
      api -X POST "$AGWMNGR/api/platform/v1/tenants/$TENANT/deployments/$dep/upgrade" \
        -H "Content-Type: application/json" \
        -d "{\"release_number\": $REL, \"request_key\": \"bind-$a-$RANDOM\"}" >/dev/null \
        && status "OK" "$a → 部署已升级到 release $REL" \
        || { FAILED=$((FAILED+1)); status "FAIL" "$a 部署升级"; }
    done
  fi
  BOUND=$((BOUND+1))
done
echo "── 完成：绑定 $BOUND / 跳过 $SKIPPED / 失败 $FAILED"
[ "$FAILED" -eq 0 ] || exit 1
