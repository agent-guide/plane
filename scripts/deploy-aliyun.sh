#!/usr/bin/env bash
# 阿里云 plane 编排栈一体化部署 —— 服务器上执行，一条命令发完。
# 设计 docs/v2/aliyun-plane-stack-deploy-plan.md（§六/§七）。
#
#   bash scripts/deploy-aliyun.sh [commit短hash|分支名]   # 缺省=分支最新
#
# 首次点火（bootstrap 例外，仅一次，runbook §六）：
#   cd /opt && git clone https://github.com/agent-guide/plane.git && cd plane
#
# 纪律与 deploy-v2.sh 同源：幂等可重放、fail-fast 探活中止、
# 镜像 tag=commit 短 hash（版本可追溯可回滚）、DEPLOYED 留档。
set -euo pipefail
# 自更新守卫（哈希判据）：脚本随仓库部署、[1] 检出可能更新自身，而 bash
# 已把旧版读进内存——"打新版号跑旧代码"。启动记自身哈希，[1] 后不一致则
# exec 换新版重跑（REEXEC 标记防循环；exec 保留环境）。
SELF_HASH_START="$(sha256sum "$0" | cut -d' ' -f1)"

BRANCH="${BRANCH:-feature/orchestration-plane}"
TARGET="${1:-}"
REPO_DIR="/opt/plane"
ENV_DIR="/opt/plane/env"
QUADLET_SRC="$REPO_DIR/scripts/quadlet"
QUADLET_DST="${XDG_CONFIG_HOME:-$HOME/.config}/containers/systemd"
DAG_DIR="/opt/plane/airflow-dags"

ok()   { echo "  ✔ $1"; }
# su/login 进入的 shell 可能缺用户总线变量（systemctl --user 依赖）——
# linger 已启用时 /run/user/<uid>/bus 存在，只是 env 没指过去（11-28 实证）
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
fail() { echo "  ✘ $1"; exit 1; }
step() { echo ""; echo "== [${1:-?}] ${2:-} =="; }

cd "$REPO_DIR"

# ── [1] 代码：拉取 + 钉版本 ─────────────────────────────────────────
step 1 "代码同步"
git fetch --all --prune 2>&1 | tail -1 || fail "git fetch 失败（网络）"
git checkout -q "${TARGET:-origin/$BRANCH}" || fail "checkout ${TARGET:-$BRANCH} 失败"
COMMIT="$(git rev-parse --short HEAD)"
echo "$COMMIT" > "$REPO_DIR/DEPLOYED"
if [ "${REEXEC:-}" != "done" ] && [ "$(sha256sum "$REPO_DIR/scripts/deploy-aliyun.sh" | cut -d' ' -f1)" != "$SELF_HASH_START" ]; then
  echo "  ↻ 脚本已更新（本仓库部署自身），换新版重跑"
  REEXEC=done exec bash "$REPO_DIR/scripts/deploy-aliyun.sh" "$@"
fi
ok "部署版本 $COMMIT（DEPLOYED 已留档）"

# ── [2] 前置初始化与校验（fail-closed：缺什么立刻停，不带病部署）────
step 2 "前置初始化与校验"
# env 文件：缺失则从模板落地（已存在不动——外置资产不随部署覆盖）
for _e in api:aliyun-api.env.example airflow:airflow.env.example; do
  _name="${_e%%:*}"; _tpl="${_e##*:}"
  if [ ! -f "$ENV_DIR/$_name.env" ]; then
    mkdir -p "$ENV_DIR"
    cp "$REPO_DIR/scripts/env/$_tpl" "$ENV_DIR/$_name.env"
    ok "env 已从模板落地（$ENV_DIR/$_name.env）"
  fi
done
# airflow SimpleAuthManager 用户文件：从 secret 生成（含密码，600 不进 git/镜像）
AFU="$(podman run --rm --secret plane-airflow-user,type=mount docker.io/library/alpine cat /run/secrets/plane-airflow-user)"
AFP="$(podman run --rm --secret plane-airflow-pass,type=mount docker.io/library/alpine cat /run/secrets/plane-airflow-pass)"
[ -n "$AFU" ] && [ -n "$AFP" ] || fail "airflow 管理凭据 secret 读取为空"
printf '%s:%s:Admin
' "$AFU" "$AFP" > /opt/plane/airflow-users.cfg
chmod 600 /opt/plane/airflow-users.cfg
unset AFU AFP
ok "airflow users.cfg 已生成（600）"
# minio Plane 侧资源：幂等引导（桶/账号/策略——已建自动跳过）
bash "$REPO_DIR/scripts/bootstrap-minio-plane.sh" || fail "minio 资源初始化失败"
# secret：缺哪些列出来（交互类不自动补——人工凭据必须人输，见 bootstrap 脚本）
_MISSING_S=""
for s in plane-pg-pass plane-minio-secret plane-secret-key plane-live-secret \
         plane-internal-token plane-tenant-token plane-airflow-db-pass \
         plane-airflow-user plane-airflow-pass; do
  podman secret inspect "$s" >/dev/null 2>&1 || _MISSING_S="$_MISSING_S $s"
done
[ -z "$_MISSING_S" ] || fail "缺 secret：$_MISSING_S（跑 scripts/bootstrap-plane-secrets.sh 交互输入，已建自动跳过）"
ok "env + minio 资源 + 9 枚 secret 齐备"

# ── [3] 构建五镜像（tag=commit，版本可追溯）─────────────────────────
step 3 "构建镜像（tag=$COMMIT）"
build() { # $1=tag名 $2=dockerfile路径
  echo "  build $1 ..."
  podman build --format docker -t "localhost/$1:$COMMIT" -f "$2" "$REPO_DIR" \
    --build-arg PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-http://8.130.36.59:19100}" \
    || fail "镜像 $1 构建失败"
}
build plane-api        apps/api/Dockerfile
build plane-web        apps/web/Dockerfile
build plane-url-mcp    services/url-mcp/Dockerfile
build plane-doc-mcp    services/doc-mcp/Dockerfile
build plane-platform-tools services/platform-tools-mcp/Dockerfile
# 官方镜像直用（airflow 三容器/redis），只确保在场
podman pull --quiet docker.io/apache/airflow:3.3.2-python3.11 >/dev/null 2>&1 || true
podman pull --quiet docker.io/library/redis:7-alpine >/dev/null 2>&1 || true
ok "五自建镜像 + 两官方镜像就绪"

# ── [3.5] 数据安全：迁移前快照 + 两个幂等迁移（失败即止）────────────
step "3.5" "数据迁移（先备份）"
BACKUP_DIR="/opt/plane/backups"
mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)-$COMMIT"
# plane 库快照（保留最近 10 份；迁移失败可由此回滚）
podman exec pg pg_dump -U plane plane > "$BACKUP_DIR/plane-$STAMP.sql"   || fail "pg_dump 失败——不带备份不做迁移"
ls -t "$BACKUP_DIR"/plane-*.sql | tail -n +11 | xargs -r rm -f
ok "plane 库已快照（plane-$STAMP.sql，保留最近 10 份）"
# Django 结构迁移（幂等：无变更 no-op；失败即止）
podman run --rm --network agw-net \
  --env-file "$ENV_DIR/api.env" \
  --secret plane-pg-pass,type=env,target=POSTGRES_PASSWORD \
  --secret plane-secret-key,type=env,target=SECRET_KEY \
  --secret plane-internal-token,type=env,target=ORCHESTRATION_INTERNAL_TOKEN \
  "localhost/plane-api:$COMMIT" python manage.py migrate \
  || fail "Django migrate 失败（可从 $BACKUP_DIR 快照回滚）"
ok "Django migrate 完成"
# Airflow 前置：pg 建 airflow 库+账号（幂等；密码=secret plane-airflow-db-pass）
# 读 secret 的可靠姿势：借一次性容器 cat 文件（inspect --format SecretData
# 在部分 podman 版本返回空——2026-11-28 实证建出过空密码账号）
AFPASS="$(podman run --rm --secret plane-airflow-db-pass,type=mount docker.io/library/alpine cat /run/secrets/plane-airflow-db-pass)"
[ -n "$AFPASS" ] || fail "plane-airflow-db-pass 读取为空"
podman exec pg psql -U postgres -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='airflow') THEN CREATE ROLE airflow LOGIN PASSWORD '${AFPASS}'; ELSE ALTER ROLE airflow PASSWORD '${AFPASS}'; END IF; END \$\$;" \
  || fail "airflow 账号创建失败"
podman exec pg psql -U postgres -tc "SELECT 1 FROM pg_database WHERE datname='airflow'" | grep -q 1 \
  || podman exec pg psql -U postgres -c "CREATE DATABASE airflow OWNER airflow;" \
  || fail "airflow 库创建失败"
unset AFPASS
ok "airflow 库+账号就绪"
# Airflow 元数据迁移（首次初始化 + 升级同一条命令）
podman run --rm --network agw-net \
  -e AIRFLOW__DATABASE__SQL_ALCHEMY_CONN_CMD="python -c \"import sys;sys.stdout.write('postgresql+psycopg://airflow:'+open('/run/secrets/plane-airflow-db-pass').read().strip()+'@pg:5432/airflow')\"" \
  --secret plane-airflow-db-pass \
  --entrypoint airflow docker.io/apache/airflow:3.3.2-python3.11 db migrate \
  || fail "airflow db migrate 失败"
ok "airflow db migrate 完成"

# ── [4] quadlet 就位 + 按依赖顺序启动 ───────────────────────────────
step 4 "容器就位与启动"
mkdir -p "$QUADLET_DST" "$DAG_DIR"
# 镜像 tag 替换：quadlet 模板写 v1 占位，部署时替换为本次 commit
for f in "$QUADLET_SRC"/*.container; do
  name="$(basename "$f")"
  sed "s/:v1$/:$COMMIT/" "$f" > "$QUADLET_DST/$name"
done
ok "quadlet ×$(ls "$QUADLET_SRC" | wc -l | tr -d ' ') 已就位（镜像 tag=$COMMIT）"
systemctl --user daemon-reload

start_unit() {  # $1=单元名
  systemctl --user enable --now "$1" >/dev/null 2>&1 || true
  systemctl --user restart "$1" || fail "$1 启动失败（journalctl --user -u $1 -n 30）"
}
# 顺序：redis → api(migrate 内含首启) → worker → web → airflow → MCP
for u in redis plane-api plane-worker plane-web \
         airflow-api airflow-scheduler airflow-worker \
         url-mcp doc-mcp platform-tools-mcp; do
  start_unit "$u"; echo "  ✔ $u 已启动"
done

# ── [5] 逐项探活（fail-fast）────────────────────────────────────────
step 5 "探活"
probe() { # $1=描述 $2=命令
  for _ in $(seq 1 30); do eval "$2" >/dev/null 2>&1 && { ok "$1"; return 0; }; sleep 2; done
  fail "$1 探活失败"
}
probe "redis PONG"       "podman exec plane-redis redis-cli ping | grep -q PONG"
probe "plane api 18101"  "curl -sf -o /dev/null http://127.0.0.1:18101/api/instances/"
probe "plane-web 19100"  "curl -sf -o /dev/null http://127.0.0.1:19100/"
probe "airflow 18090"    "curl -sf -o /dev/null http://127.0.0.1:18090/health"
probe "url-mcp 8624"     "curl -sf http://127.0.0.1:8624/health | grep -q url_reader"
probe "doc-mcp 8625"     "curl -sf http://127.0.0.1:8625/health | grep -q parse_document"
ok "探活全过"

# ── [6] 汇总 ────────────────────────────────────────────────────────
step 6 "部署完成"
echo "  版本: $COMMIT    容器: $(podman ps --format '{{.Names}}' | grep -cE 'plane|airflow|redis|url-mcp|doc-mcp|platform-tools')"
echo "  下一步（runbook §七 8-14）: 平台链注册 → 发布流程验证 → 端到端验收"
