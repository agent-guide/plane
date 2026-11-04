#!/usr/bin/env bash
# agwmngr v2 部署脚本 —— Mac 侧执行，一条命令发完。
#
#   bash scripts/deploy-agwmngr-v2.sh [服务器IP] [agwmngr本地仓库路径]
#
# 与 deploy-v2.sh 同族同纪律：全量同步 + 保留清单（.env.local / 数据库 /
# node_modules）+ 重启 + 探活 fail-closed。
# 背景（2026-11-04）：agwmngr 此前无部署脚本（dual-deploy §3.2 时代手工
# rsync），按「部署只走标准脚本」红线补齐；服务器目录非 git checkout。
set -euo pipefail

SERVER="${1:-223.105.56.202}"
SRC="${2:-$HOME/Desktop/shu/experts-frontend/agwmngr}"
SSH_PORT="${SSH_PORT:-51022}"
REMOTE_USER="${REMOTE_USER:-dongqian}"
DEST="/opt/projects/ai-platform/v2/agwmngr"

[ -d "$SRC/.next" ] || { echo "❌ $SRC 缺 .next 构建产物，先 bun run build"; exit 1; }
[ -f "$SRC/package.json" ] || { echo "❌ $SRC 不是 agwmngr 仓库"; exit 1; }

echo "==== [1/3] 同步代码与构建产物（保留 env/数据/依赖）===="
# 保留：.env.local*（服务器侧密钥与 DB 路径）、data、node_modules（依赖
# 无变化时跳过传输；lockfile 变化时先本地 bun install 再来）
rsync -a --delete \
  --exclude 'node_modules' --exclude '.env.local*' --exclude '.git' \
  --exclude '._*' --exclude 'data' \
  -e "ssh -p $SSH_PORT" "$SRC/" "$REMOTE_USER@$SERVER:$DEST/"

echo "==== [2/3] 重启 ===="
ssh -p "$SSH_PORT" "$REMOTE_USER@$SERVER" \
  "sudo -n systemctl restart agwmngr-v2 && sleep 4 && systemctl is-active agwmngr-v2"

echo "==== [3/3] 探活（fail-closed）===="
ssh -p "$SSH_PORT" "$REMOTE_USER@$SERVER" '
  code=$(curl -s -o /dev/null -w "%{http_code}" 127.0.0.1:4005/api/admin/health)
  [ "$code" = "200" ] || { echo "❌ agwmngr 健康检查失败（$code），回滚：sudo systemctl restart agwmngr-v2 前先检查 journalctl"; exit 1; }
  echo "agwmngr 4005: $code"
'
echo "✅ agwmngr v2 部署完成（env/data/依赖未动）"
