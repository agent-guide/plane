#!/bin/bash
# 平台链 e2e 一键冒烟：每次运行建一套**全新**项目/团队/流程/卡（唯一命名，杜绝脏版本历史复用），
# 登录 → 团队(人工+agent) → 发布 → 绑定 → 建卡 → 轮询终态（waiting_human→批准→completed）。
# 前置：up.sh + provision.sh 全绿。失败打印各环节实际响应。
set -euo pipefail
cd "$(dirname "$0")"
source lib/common.sh

JAR=/tmp/local-smoke-cookies.txt; rm -f "$JAR"
API="http://127.0.0.1:$API_PORT"
BASE="$API/api/workspaces/$PLANE_WORKSPACE_SLUG"
STAMP="$(date +%s)"
IDENT="S${STAMP: -6}"            # 唯一项目 identifier（Plane 要求大写字母）
TNAME="smoke-team-$STAMP"
WNAME="smoke-flow-$STAMP"
CSRF=""

call() { # call <方法> <完整URL> [--json <body>] → body；非 2xx 报错
  local m=$1 u=$2 body="" json=0; shift 2
  [ "${1:-}" = "--json" ] && { json=1; body="$2"; shift 2; }
  local out; out="$(mktemp)"
  local code
  if [ "$json" = 1 ]; then
    code=$(curl -s -o "$out" -w '%{http_code}' -b "$JAR" -c "$JAR" -X "$m" "$u" \
      -H "Content-Type: application/json" -H "X-CSRFToken: $CSRF" -H "Referer: http://localhost:$WEB_PORT/" --data "$body")
  else
    code=$(curl -s -o "$out" -w '%{http_code}' -b "$JAR" -c "$JAR" -X "$m" "$u" \
      -H "X-CSRFToken: $CSRF" -H "Referer: http://localhost:$WEB_PORT/")
  fi
  if [[ "$code" != 2* ]]; then echo "HTTP $code for $m $u" >&2; head -c 400 "$out" >&2; echo >&2; rm -f "$out"; return 1; fi
  cat "$out"; rm -f "$out"
}
jq() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }

step "① 登录（\${PLANE_ADMIN_EMAIL}）"
CSRF=$(curl -s -c "$JAR" "$API/auth/get-csrf-token/" | jq "d['csrf_token']")
curl -s -o /dev/null -b "$JAR" -c "$JAR" -X POST "$API/auth/sign-in/" \
  -H "X-CSRFToken: $CSRF" -H 'Referer: http://localhost:3000/' \
  --data-urlencode "email=$PLANE_ADMIN_EMAIL" --data-urlencode "password=$PLANE_ADMIN_PASSWORD" \
  && ok "登录成功" || fail "登录失败（账号见 scripts/local/.env）"
CSRF=$(curl -s -b "$JAR" -c "$JAR" "$API/auth/get-csrf-token/" | jq "d['csrf_token']")

step "② 项目（全新，identifier=\${IDENT}）"
call POST "$BASE/projects/" --json "{\"name\":\"smoke$STAMP\",\"identifier\":\"$IDENT\",\"network\":2}" >/tmp/smoke-p.json
PID=$(jq "d['id']" < /tmp/smoke-p.json); ok "项目已建 ${PID:0:8}"
PBASE="$BASE/projects/$PID"

step "③ 团队 → 流程 → 发布 → 绑定"
UID_ME=$(curl -s -b "$JAR" "$API/api/users/me/" | jq "d['id']")
call POST "$BASE/agent-teams/" --json "{\"name\":\"$TNAME\",\"objective\":\"smoke\"}" >/tmp/smoke-t.json
TID=$(jq "d['id']" < /tmp/smoke-t.json)
call POST "$BASE/agent-teams/$TID/members/" --json "{\"kind\":\"human\",\"role\":\"owner\",\"userId\":\"$UID_ME\",\"sequence\":1}" >/dev/null
AGENT_ID=$(call GET "$BASE/agent-teams/agent-catalog/" 2>/dev/null | python3 -c 'import json,sys;a=json.load(sys.stdin);print(a[0]["id"] if a else "")' 2>/dev/null || echo "")
if [ -n "$AGENT_ID" ]; then
  call POST "$BASE/agent-teams/$TID/members/" --json "{\"kind\":\"agent\",\"agentDefinitionId\":\"$AGENT_ID\",\"role\":\"执行者\",\"sequence\":2}" >/dev/null && ok "agent 成员 $AGENT_ID"; else warn "目录无 agent——流程仅人工节点"; fi
call POST "$BASE/agent-teams/$TID/activate/" --json '{}' >/dev/null
call POST "$PBASE/team-bindings/" --json "{\"teamId\":\"$TID\"}" >/dev/null
call POST "$PBASE/workflows/" --json "{\"name\":\"$WNAME\",\"description\":\"smoke\"}" >/tmp/smoke-w.json
WID=$(jq "d['id']" < /tmp/smoke-w.json); ok "流程已建"
GRAPH="{\"version\":1,\"nodes\":[{\"id\":\"review\",\"type\":\"human_confirm\",\"position\":{\"x\":240,\"y\":200},\"data\":{\"name\":\"人工确认\",\"prompt\":\"smoke\",\"approverUserId\":\"$UID_ME\"}}],\"edges\":[]}"
call PATCH "$PBASE/workflows/$WID/" --json "{\"draft\":$GRAPH}" >/dev/null || fail "草稿保存失败"
call POST "$PBASE/workflows/$WID/versions/" --json '{}' >/tmp/smoke-v.json
VID=$(jq "d['id']" < /tmp/smoke-v.json)
call POST "$PBASE/workflows/$WID/versions/$VID/publish/" --json '{}' >/dev/null
# 发布异步（worker 上传 DAG → dag-processor 扫描就绪才收口）；轮询到 published 再绑定
SECONDS=0
while :; do
  VST=$(curl -s -b "$JAR" "$PBASE/workflows/$WID/" | jq "next((v['status'] for v in d['versions'] if v['id']=='$VID'),'')" 2>/dev/null || echo "")
  [ "$VST" = "published" ] && break
  [ $SECONDS -ge 120 ] && fail "版本 $VID 120s 未收口 published（当前 ${VST:-publishing}）——dag-processor 未扫描到 DAG"
  sleep 3
done
ok "版本已发布"
call PATCH "$PBASE/team-bindings/" --json "{\"workflowVersionId\":\"$VID\"}" >/dev/null; ok "绑定已挂版本"

step "④ 建卡 → 轮询终态（≤240s）"
call POST "$PBASE/issues/" --json "{\"name\":\"smoke-$STAMP\",\"description_html\":\"<p>冒烟卡 $STAMP</p>\",\"priority\":\"medium\"}" >/tmp/smoke-i.json
ISSUE=$(jq "d['id']" < /tmp/smoke-i.json); ok "卡已建 ${ISSUE:0:8}"
SECONDS=0
while :; do
  ST=$(curl -s -b "$JAR" "$PBASE/work-items/$ISSUE/runtime/" | jq "d.get('businessStatus') or ''" 2>/dev/null || echo "")
  case "$ST" in
    waiting_human)
      ok "到达 waiting_human"
      AID=$(curl -s -b "$JAR" "$PBASE/work-items/$ISSUE/runtime/" | jq "(d.get('pendingApproval') or {}).get('id','')")
      call POST "$BASE/agent-teams/approvals/$AID/" --json '{"decision":"approved"}' >/dev/null && ok "已批准";;
    completed) ok "e2e 冒烟通过（completed）"; exit 0;;
    failed) fail "执行 failed —— 详情 $PBASE/work-items/$ISSUE/runtime/（/tmp/plane-worker.log）";;
  esac
  [ $SECONDS -ge 240 ] && fail "240s 未到终态（当前 ${ST:-无状态}）"
  sleep 5
done
