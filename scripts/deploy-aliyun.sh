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

BRANCH="${BRANCH:-feature/orchestration-plane}"
TARGET="${1:-}"
REPO_DIR="/opt/plane"
ENV_DIR="/opt/plane/env"
QUADLET_SRC="$REPO_DIR/scripts/quadlet"
QUADLET_DST="${XDG_CONFIG_HOME:-$HOME/.config}/containers/systemd"
DAG_DIR="/opt/plane/airflow-dags"

ok()   { echo "  ✔ $1"; }
fail() { echo "  ✘ $1"; exit 1; }
step() { echo ""; echo "== [${1:-?}] ${2:-} =="; }

cd "$REPO_DIR"

# ── [1] 代码：拉取 + 钉版本 ─────────────────────────────────────────
step 1 "代码同步"
git fetch --all --prune 2>&1 | tail -1 || fail "git fetch 失败（网络）"
git checkout -q "${TARGET:-origin/$BRANCH}" || fail "checkout ${TARGET:-$BRANCH} 失败"
COMMIT="$(git rev-parse --short HEAD)"
echo "$COMMIT" > "$REPO_DIR/DEPLOYED"
ok "部署版本 $COMMIT（DEPLOYED 已留档）"

# ── [2] 前置校验（fail-closed：缺什么立刻停，不带病部署）────────────
step 2 "前置校验"
[ -f "$ENV_DIR/api.env" ] || fail "缺 $ENV_DIR/api.env（先拷 scripts/env/aliyun-api.env.example 并填好）"
for s in plane-pg-pass plane-minio-secret plane-secret-key plane-live-secret \
         plane-internal-token plane-tenant-token plane-airflow-db-pass \
         plane-airflow-user plane-airflow-pass; do
  podman secret inspect "$s" >/dev/null 2>&1 || fail "缺 secret $s（先跑 scripts/bootstrap-plane-secrets.sh）"
done
ok "env + 9 枚 secret 齐备"

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
  -v "$ENV_DIR/api.env:/app/apps/api/.env:ro,Z" \
  --secret plane-pg-pass,type=env,target=POSTGRES_PASSWORD \
  --secret plane-secret-key,type=env,target=SECRET_KEY \
  "localhost/plane-api:$COMMIT" python manage.py migrate \
  || fail "Django migrate 失败（可从 $BACKUP_DIR 快照回滚）"
ok "Django migrate 完成"
# Airflow 元数据迁移（首次初始化 + 升级同一条命令）
podman run --rm --network agw-net \
  -e AIRFLOW__DATABASE__SQL_ALCHEMY_CONN_CMD="python -c \"import os;print('postgresql+psycopg://airflow:'+open('/run/secrets/plane-airflow-db-pass').read().strip()+'@pg:5432/airflow')\"" \
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
