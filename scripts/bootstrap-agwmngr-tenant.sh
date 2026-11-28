#!/bin/bash
# agwmngr 租户服务凭证（agwmngr_svc_*）铸造/更换/验证 —— 目标机本地执行。
# 设计 docs/v2/aliyun-plane-stack-deploy-plan.md §五/§十（凭据 ≤366 天强制过期，
# 无 renew 接口、铸造需平台管理员——人工/脚本日历轮换为当前正解）。
#
#   bash scripts/bootstrap-agwmngr-tenant.sh --check    # 只验证当前 secret 里的 token 是否可用
#   bash scripts/bootstrap-agwmngr-tenant.sh --list     # 列租户（确认 tenant_id 用）
#   bash scripts/bootstrap-agwmngr-tenant.sh            # 铸新 token（默认输出到终端）
#   bash scripts/bootstrap-agwmngr-tenant.sh --rotate   # 铸新 + 直接替换 podman secret plane-tenant-token
#
# 凭据经环境变量或交互输入（不落 shell 历史/文件）；实战场记（2026-11-28）：
#   ① 登录响应 token 在顶层 {token:...}（非旧版 d.token 嵌套）
#   ② 租户列表在 /identity/tenants（非 /tenants）
#   ③ expires_at 必须 ≤366 天（超出报 credential expiry must be within one year）
#   ④ 同名 principal 已存在报 conflict——先在管理端删除旧的或换名（--name）
set -euo pipefail

MODE="${1:-}"
AGWMNGR="${AGWMNGR:-http://127.0.0.1:19000}"
TENANT_ID="${TENANT_ID:-default-agw-tenant}"
SVC_NAME="${SVC_NAME:-plane-orchestration}"
SECRET_NAME="${SECRET_NAME:-plane-tenant-token}"
# 默认有效期：今天 +365 天（代码上限 366）
EXPIRY="$(date -u -d "+365 days" +%Y-%m-%dT00:00:00Z 2>/dev/null || date -u -v+365d +%Y-%m-%dT00:00:00Z)"

status() { echo "  [$1] $2"; }
die()   { echo "  ✘ $1"; exit 1; }
jsonget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

_login() {
  local u p
  u="${AGWMNGR_ADMIN_USER:-}"; p="${AGWMNGR_ADMIN_PASS:-}"
  [ -z "$u" ] && read -r -p "agwmngr 平台管理员用户名: " u
  [ -z "$p" ] && read -r -s -p "密码: " p && echo
  SESSION=$(curl -sf "$AGWMNGR/api/admin/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"$u\",\"password\":\"$p\"}" | jsonget "d['token']") \
    || die "登录失败（检查账号密码 / $AGWMNGR 是否在线）"
}

case "$MODE" in
  --list)
    _login
    echo "租户列表："
    curl -sf "$AGWMNGR/api/platform/v1/identity/tenants" \
      -H "Authorization: Bearer $SESSION" \
      | python3 -c "import json,sys
for t in json.load(sys.stdin)['items']: print(f\"  {t['id']:24} {t['name']}  ({t['status']})\")"
    ;;
  --check)
    # 从 podman secret 读当前 token，调 identity access 验可用性
    TOKEN=$(podman secret inspect "$SECRET_NAME" --format '{{.SecretData}}' 2>/dev/null \
      | base64 -d 2>/dev/null || true)
    [ -n "$TOKEN" ] || die "secret $SECRET_NAME 读不到（未创建？）"
    CODE=$(curl -s -o /dev/null -w '%{http_code}' "$AGWMNGR/api/platform/v1/identity/access" \
      -H "Authorization: Bearer $TOKEN")
    case "$CODE" in
      200) status OK "当前 token 有效（HTTP 200）" ;;
      401|403) die "token 已失效/过期（HTTP $CODE）——需要轮换（不带参数跑本脚本铸新）" ;;
      *) die "意外响应 HTTP $CODE（agwmngr 状态？）" ;;
    esac
    ;;
  ""|--rotate)
    _login
    status "OK" "登录成功，铸造服务凭证（租户=$TENANT_ID 名称=$SVC_NAME 有效期至 $EXPIRY）"
    RESP=$(curl -sf "$AGWMNGR/api/platform/v1/identity/service-principals" \
      -H "Authorization: Bearer $SESSION" -H "Content-Type: application/json" \
      -d "{\"name\":\"$SVC_NAME\",\"expires_at\":\"$EXPIRY\",\"tenant_id\":\"$TENANT_ID\",\"role\":\"admin\"}") \
      || die "铸造失败（409=同名已存在：管理端删旧或 SVC_NAME=新名重跑；400=有效期超 366 天）"
    NEW_TOKEN=$(printf '%s' "$RESP" | jsonget "d['token']")
    case "$NEW_TOKEN" in agwmngr_svc_*) ;; *) die "响应异常（未取到 token）：$RESP";; esac
    status "OK" "新 token 已铸（${NEW_TOKEN:0:16}...，到期 $EXPIRY）"
    if [ "$MODE" = "--rotate" ]; then
      printf '%s' "$NEW_TOKEN" | podman secret rm "$SECRET_NAME" >/dev/null 2>&1 || true
      printf '%s' "$NEW_TOKEN" | podman secret create "$SECRET_NAME" - >/dev/null \
        || die "secret 替换失败（手工：podman secret rm/create）"
      status "OK" "podman secret $SECRET_NAME 已替换（重启生效：systemctl --user restart plane-api plane-worker）"
    else
      echo "$NEW_TOKEN" > /tmp/plane-tenant-token.$$
      chmod 600 /tmp/plane-tenant-token.$$
      echo "  ⚠️ token 已暂存 /tmp/plane-tenant-token.$$（600）——替换："
      echo "     cat /tmp/plane-tenant-token.$$ | podman secret rm $SECRET_NAME; cat /tmp/plane-tenant-token.$$ | podman secret create $SECRET_NAME -"
    fi
    ;;
  *) echo "用法：$0 [--list|--check|--rotate]"; exit 1 ;;
esac
