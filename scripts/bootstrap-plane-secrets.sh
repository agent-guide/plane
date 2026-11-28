#!/bin/bash
# plane 栈凭据初始化（podman secret）——目标机 ops 下执行，幂等可重放。
# 设计 docs/v2/aliyun-plane-stack-deploy-plan.md §五。
#   bash scripts/bootstrap-plane-secrets.sh            # 交互输入已有凭据类
#   bash scripts/bootstrap-plane-secrets.sh --check    # 只列状态不创建
#
# 原则：新生成类就地 openssl 随机；人工持有类（pg/minio/tenant/airflow）交互
# 输入（不落 shell 历史/文件）；已存在的 secret 跳过不动（幂等）。
set -euo pipefail

CHECK_ONLY="${1:-}"
status() { echo "  [$1] $2"; }

ensure_secret() { # $1=名 $2=生成方式（gen=openssl 随机 / ask=交互输入 / file=读文件）
  local name="$1" mode="$2" tmp
  if podman secret inspect "$name" >/dev/null 2>&1; then
    status "OK" "secret $name 已存在（跳过）"; return 0
  fi
  if [ -n "$CHECK_ONLY" ]; then status "MISS" "secret $name 缺失"; return 0; fi
  tmp="$(mktemp)"; trap 'rm -f "$tmp"' RETURN
  case "$mode" in
    gen) openssl rand -hex 32 | tr -d '\n' > "$tmp" ;;
    ask) read -r -s -p "输入 $name 的值: " v; echo; [ -n "$v" ] || { echo "FAIL: 空值"; exit 1; }; printf '%s' "$v" > "$tmp" ;;
    *) echo "FAIL: 未知模式 $mode"; exit 1 ;;
  esac
  podman secret create "$name" "$tmp" >/dev/null && rm -f "$tmp" && status "ADD" "secret $name 已创建"
}

echo "== plane 凭据初始化（podman secret）=="
# 新生成类（随机，无人需要知道原文）
ensure_secret plane-secret-key       gen   # Django SECRET_KEY
ensure_secret plane-live-secret      gen   # LIVE_SERVER_SECRET_KEY
ensure_secret plane-internal-token   gen   # ORCHESTRATION_INTERNAL_TOKEN
ensure_secret plane-airflow-db-pass  gen   # Airflow 元数据库密码
ensure_secret plane-airflow-user     gen   # Airflow 管理账号名（随机串即可）
ensure_secret plane-airflow-pass     gen   # Airflow 管理密码
# 人工持有类（部署者掌握的既有值）
ensure_secret plane-pg-pass          ask   # plane 库密码（建库时定的）
ensure_secret plane-minio-secret     ask   # minio plane 账号 SK
ensure_secret plane-tenant-token     ask   # agwmngr_svc_*（铸出后回填）

echo "== 汇总 =="
podman secret ls | grep '^plane-' || true
echo "完成。airflow 管理账号名（plane-airflow-user）需回填 users.cfg（见部署 runbook）。"
