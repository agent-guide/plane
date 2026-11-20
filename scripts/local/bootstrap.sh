#!/bin/bash
# 一次性依赖引导（幂等）：brew 工具链 → Python/Airflow venv → 前端依赖 → packages 构建。
# 版本钉死禁 latest；国内网络自动走 Clash（探测 7890）与清华镜像（gettext 源码包坑）。
set -euo pipefail
cd "$(dirname "$0")"

# ── 代理探测（网络在「直连↔Clash」间漂移，装包两种都试）──
PROXY=""
if nc -z 127.0.0.1 7890 2>/dev/null; then
  PROXY="http://127.0.0.1:7890"
  # 仅当直连 github 不通才挂代理
  curl -sf --max-time 6 -o /dev/null https://github.com && PROXY="" || true
fi
if [ -n "$PROXY" ]; then export ALL_PROXY=$PROXY http_proxy=$PROXY https_proxy=$PROXY; echo "↳ 走代理 $PROXY"; else echo "↳ 直连"; fi

have() { command -v "$1" >/dev/null 2>&1; }
step()  { printf "\n\033[1m== %s ==\033[0m\n" "$*"; }
ok()    { printf "  \033[32m[OK]\033[0m %s\n" "$*"; }

step "① Homebrew（无 sudo 前缀 ~/homebrew，Tier 3 无 bottle —— PG 为源码编译，耐心）"
export PATH="$HOME/homebrew/bin:$PATH"
if have brew; then ok "brew $(brew --version | head -1)"; else
  mkdir -p ~/homebrew
  curl -fsSL https://github.com/Homebrew/brew/tarball/main | tar xz --strip-components 1 -C ~/homebrew
  ok "brew 已安装到 ~/homebrew"; fi

step "② 基础工具链（版本钉死由 brew formula 管理）"
for f in go pnpm redis; do
  brew list "$f" >/dev/null 2>&1 && ok "$f 已装" || { brew install "$f" && ok "$f 已装"; }
done
brew list postgresql@15 >/dev/null 2>&1 && ok "PG15 已装" || {
  # 坑：gettext 源码包从 ftp.gnu.org 直连仅 ~14KB/s 且超时会触发 brew Ruby 崩溃
  # —— 先用清华镜像手动落缓存再装
  GETTEXT_CACHE="$HOME/Library/Caches/Homebrew/downloads"
  mkdir -p "$GETTEXT_CACHE"
  if ! ls "$GETTEXT_CACHE"/*--gettext-1.0.tar.gz >/dev/null 2>&1; then
    curl -fsSL -o "$GETTEXT_CACHE/smoke--gettext-1.0.tar.gz" \
      https://mirrors.tuna.tsinghua.edu.cn/gnu/gettext/gettext-1.0.tar.gz
    # brew 缓存文件名带 sha 前缀，让 brew 自己取（此处预热网络连通性即可）
    rm -f "$GETTEXT_CACHE/smoke--gettext-1.0.tar.gz"
  fi
  brew install postgresql@15 && ok "PG15 已装（源码编译耗时属预期）"
}

step "③ bun（agwmngr 钉定运行时）+ uv（Python 管理）"
have bun || { curl -fsSL https://bun.sh/install | bash; }
export PATH="$HOME/.bun/bin:$PATH"; ok "bun $(bun --version)"
have uv || curl -fsSL https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"; ok "uv $(uv --version | awk '{print $2}')"

step "④ Plane API venv（Python 3.12）"
API_DIR="$(cd ../apps/api && pwd)"
[ -x "$API_DIR/.venv/bin/python" ] || uv venv "$API_DIR/.venv" --python 3.12
uv pip install --python "$API_DIR/.venv/bin/python" -r "$API_DIR/requirements/local.txt" >/dev/null
ok "api venv 就绪"

step "⑤ Airflow 3.3 venv（官方 constraints 钉死）"
AF_HOME="${AIRFLOW_HOME_DIR:-$HOME/airflow-local}"
mkdir -p "$AF_HOME"
[ -x "$AF_HOME/.venv/bin/airflow" ] || uv venv "$AF_HOME/.venv" --python 3.12
uv pip install --python "$AF_HOME/.venv/bin/python" 'apache-airflow==3.3.*' \
  --constraints <(curl -fsSL https://raw.githubusercontent.com/apache/airflow/constraints-3.3.0/constraints-3.12.txt) >/dev/null
ok "airflow $($AF_HOME/.venv/bin/airflow version)"
[ -f "$AF_HOME/airflow.cfg" ] || AIRFLOW_HOME=$AF_HOME "$AF_HOME/.venv/bin/airflow db migrate >/dev/null 2>&1" || true
[ -f "$AF_HOME/airflow.db" ] || AIRFLOW_HOME=$AF_HOME "$AF_HOME/.venv/bin/airflow" db migrate >/dev/null
ok "airflow db 已初始化（sqlite）"

step "⑥ 前端依赖与 packages 构建（改 packages/* 后须重跑本步并重启 web——dist 消费）"
export PATH="$HOME/homebrew/bin:$PATH"
(cd ../../ && pnpm install >/dev/null) && ok "pnpm install 完成"
(cd ../../ && pnpm turbo run build --filter='@plane/*' >/dev/null) && ok "packages 已构建"
(cd "$HOME/Desktop/shu/agwmngr" 2>/dev/null && bun install >/dev/null && ok "agwmngr 依赖已装") || warn "agwmngr 目录不存在（AGWMNGR_DIR 覆盖路径）"

step "⑦ SeaweedFS 二进制（darwin_arm64，版本钉死 3.90）"
WEED_DIR="$HOME/seaweedfs"
if [ -x "$WEED_DIR/weed" ]; then ok "weed 已就绪"; else
  mkdir -p "$WEED_DIR"
  curl -fsSL -A "Mozilla/5.0" -o "$WEED_DIR/weed.tar.gz" https://github.com/seaweedfs/seaweedfs/releases/download/3.90/darwin_arm64.tar.gz
  tar xzf "$WEED_DIR/weed.tar.gz" -C "$WEED_DIR" && rm -f "$WEED_DIR/weed.tar.gz"
  ok "weed 已下载"; fi

step "⑧ 网关二进制（tag 钉死 v0.8.0-preview.1）"
GW_DIR="${GATEWAY_DIR:-$HOME/Desktop/shu/agent-gateway}"
if [ ! -x "$GW_DIR/agw" ]; then
  (cd "$GW_DIR" && git checkout -q v0.8.0-preview.1 2>/dev/null || git checkout -q release/v0.8.0-preview.1; make build >/dev/null)
fi
ok "网关 $GW_DIR/agw 就绪"

echo; echo "✅ bootstrap 完成。下一步：bash scripts/local/gen-env.sh && bash scripts/local/up.sh"
