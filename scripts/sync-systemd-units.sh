#!/usr/bin/env bash
# systemd 单元同步 —— 仓库模板（scripts/systemd/）→ 测试服务器。
#
#   bash scripts/sync-systemd-units.sh [服务器IP] [--diff]
#
# 模板是单元的唯一权威（2026-11-11 定案：手工放服务器的单元配置漂移是
# 11-03/11-10/11-11 三次事故的共同温床）。本脚本：diff 服务器与模板 →
# 不一致时同步 + daemon-reload + 重启对应服务。--diff 只看不改。
#
# ⚠️ agw-hostd / seaweedfs 当前仍是手工 nohup 拉起（backlog）——首次执行
# 会把它们转入 systemd 监管（先停手工进程再 enable+start，防双进程抢端口）。
set -uo pipefail
SERVER="${1:-223.105.56.202}"
[[ "${2:-}" == "--diff" ]] && DIFF_ONLY=1 || DIFF_ONLY=0
SSH_PORT="${SSH_PORT:-51022}"
REMOTE_USER="${REMOTE_USER:-dongqian}"
HERE="$(cd "$(dirname "$0")" && pwd)"

UNITS=(plane-v2-api plane-v2-worker agwmngr-v2 agent-gateway agw-hostd seaweedfs)
echo "==== systemd 单元同步 → $REMOTE_USER@$SERVER (diff-only=$DIFF_ONLY) ===="
for unit in "${UNITS[@]}"; do
  src="$HERE/systemd/$unit.service"
  [ -f "$src" ] || { echo "❌ 模板缺失: $src"; exit 1; }
  scp -q -P "$SSH_PORT" "$src" "$REMOTE_USER@$SERVER:/tmp/$unit.service"
done

ssh -p "$SSH_PORT" "$REMOTE_USER@$SERVER" DIFF_ONLY="$DIFF_ONLY" 'bash -s' <<'REMOTE'
set -uo pipefail
for unit in plane-v2-api plane-v2-worker agwmngr-v2 agent-gateway agw-hostd seaweedfs; do
  dst="/etc/systemd/system/$unit.service"
  if [ ! -f "$dst" ]; then
    echo "$unit: 服务器缺失（新服务，将安装）"
    [ "$DIFF_ONLY" = "1" ] && continue
    if ! sudo -n cp "/tmp/$unit.service" "$dst"; then echo "  ⚠ $unit 安装需 sudo 密码，跳过（手工执行：sudo cp /tmp/$unit.service $dst）"; continue; fi
  elif cmp -s "/tmp/$unit.service" "$dst"; then
    echo "$unit: 一致"; continue
  else
    echo "$unit: 存在差异"
    diff "$dst" "/tmp/$unit.service" | head -10
    [ "$DIFF_ONLY" = "1" ] && continue
    if ! sudo -n cp "/tmp/$unit.service" "$dst"; then echo "  ⚠ $unit 更新需 sudo 密码，跳过（手工执行：sudo cp /tmp/$unit.service $dst && sudo systemctl daemon-reload）"; continue; fi
  fi
  [ "$DIFF_ONLY" = "1" ] && continue
  sudo -n systemctl daemon-reload 2>/dev/null || echo "  ⚠ daemon-reload 需 sudo"
done
echo "---- 服务状态（需重启的单元请确认时机后手动重启或重跑部署）----"
for unit in plane-v2-api plane-v2-worker agwmngr-v2 agent-gateway agw-hostd seaweedfs; do
  state=$(systemctl is-active "$unit" 2>/dev/null || echo missing)
  enabled=$(systemctl is-enabled "$unit" 2>/dev/null || echo no)
  echo "$unit: $state (enabled=$enabled)"
done
REMOTE
