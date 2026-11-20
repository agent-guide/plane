#!/bin/bash
# 本地栈巡检（对齐 deploy-v2.sh --check 语义）：逐项探活并校验响应体/契约。
# 退出码非 0 = 有 FAIL，可挂 CI 或拉起后自检。
set -uo pipefail
cd "$(dirname "$0")"
source lib/common.sh
RC=0
chk() { if eval "$2"; then ok "$1"; else fail "$1"; RC=1; fi; }

step "巡检本地栈（api :$API_PORT / agwmngr :$MGR_PORT / gw :$GW_ADMIN_PORT / airflow :${AIRFLOW_PORT}）"
chk "PG 可连（业务库）"             "$PSQL \"$DB_URL\" -tc 'SELECT 1' >/dev/null 2>&1"
chk "Redis PONG"                     "$REDIS_CLI -p $REDIS_PORT ping 2>/dev/null | grep -q PONG"
chk "gateway admin 健康"             "probe_http 200 http://127.0.0.1:$GW_ADMIN_PORT/admin/health"
chk "gateway 数据面健康"             "probe_http 200 http://127.0.0.1:8080/healthz"
chk "url-mcp 存活（链接读取工具 :8624）" "probe_http 200 http://127.0.0.1:8624/health"
chk "doc-mcp 存活（文档解析工具 :8625）" "probe_http 200 http://127.0.0.1:8625/health"
# .doc/.ppt 引擎水位（非阻断：olefile 兜底可用，soffice 缺失仅降级中文质量）
command -v soffice >/dev/null 2>&1 && ok "soffice 可用（.doc/.ppt 高质量引擎）" \
  || hint "soffice 不在 PATH：.doc/.ppt 走 olefile 兜底（中文可能带噪音）"
chk "Plane api 存活"                 "probe_contains http://127.0.0.1:$API_PORT/api/instances/ 'is_setup_done'"
chk "Plane web 存活"                 "probe_http 200 http://localhost:$WEB_PORT/"
chk "编排 worker 在运行（且仅单实例）" "[ \"\$(pgrep -f '[p]rocrastinate_worker.py' | wc -l | tr -d ' ')\" = 1 ]"
chk "agwmngr 健康"                   "probe_contains http://127.0.0.1:$MGR_PORT/api/admin/health 'ok\|{}'"
chk "Airflow api-server 健康"        "probe_contains http://127.0.0.1:$AIRFLOW_PORT/api/v2/monitor/health 'healthy\|ok'"

step "跨服务契约抽检（plane 依赖的 agwmngr 字段子集）"
chk "plane→agwmngr 令牌有效（租户 agents 可读）" "[ -n \"\${TENANT_TOKEN:-}\" ] && curl -sf -H \"Authorization: Bearer \$TENANT_TOKEN\" http://127.0.0.1:$MGR_PORT/api/platform/v1/tenants/$TENANT_ID/agents | grep -q 'items'"
# 网关连通测试（agwmngr 视角）：登录拿 admin token → /gateways/{GW_ID}/test
_gw_test() {
  local t; t="$(curl -sf -X POST "http://127.0.0.1:$MGR_PORT/api/admin/auth/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$MGR_ADMIN_USER\",\"password\":\"$MGR_ADMIN_PASSWORD\"}" | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])' 2>/dev/null)"
  [ -n "$t" ] && curl -sf -X POST "http://127.0.0.1:$MGR_PORT/api/admin/gateways/$GW_ID/test" -H "Authorization: Bearer $t" -H 'Content-Type: application/json' -d '{}' | grep -q '"ok":true'
}
chk "gateway 网关注册健康（agwmngr 侧连通）" "_gw_test"

step "发布/引擎漂移检测（published 版本 ↔ DAG 文件）"
# 无引擎窗口期发布的版本会标 published 但 DAG 从未落盘 → 绑定后建卡 engine.start 404。
_drift() {
  (cd "$REPO_ROOT/apps/api" && set -a && source .env 2>/dev/null && set +a && \
   DJANGO_SETTINGS_MODULE=plane.settings.local .venv/bin/python - 2>/dev/null <<'PY'
import django; django.setup()
import os
from plane.orchestration.models import ProjectTeamBinding
from pathlib import Path
root = Path(os.environ.get("ORCHESTRATION_DAG_ROOT", "/tmp/agent-team-dags"))
bad = []
for b in ProjectTeamBinding.objects.filter(status="active").select_related("workflow_version"):
    v = b.workflow_version
    if not v:
        continue
    f = root / f"wf_{str(v.workflow_id)[-9:]}_v{v.version}.py"  # 同 dag_publication.dag_id
    if not f.exists():
        bad.append(f"wf_{str(v.workflow_id)[:8]} v{v.version}")
print("DRIFT:", ", ".join(bad) if bad else "OK")
PY
  ) | grep -q '^DRIFT: OK$'
}
chk "活跃绑定版本的 DAG 文件均在引擎侧" "_drift"

[ $RC -eq 0 ] && echo && ok "巡检全部通过" || { echo; fail "巡检存在 FAIL 项（见上）"; }
exit $RC
