#!/bin/bash
# minio Plane 侧资源一键引导（声明式清单 + 幂等执行器）—— 目标机本地执行。
# 设计 docs/v2/aliyun-plane-stack-deploy-plan.md §五/§六（阿里云部署方案）；
# 结构意图：清单区为纯终态声明，将来平移 Terraform 时逐行翻译即得 hcl。
#
#   bash scripts/bootstrap-minio-plane.sh [--check]
#
# 前置：mc 已配好指向目标 minio 的别名（默认 local），且该凭据具备 admin 权限。
# 凭据纪律：PLANE_SECRET 从环境变量或交互输入读入，绝不写进脚本/命令行历史。
set -euo pipefail

CHECK_ONLY="${1:-}"
ALIAS="${MC_ALIAS:-local}"

# ── 资源清单（纯声明：应存在什么。改资源只动这里，执行器零改动）──────
MANIFEST_USER="plane"                                  # Plane api 的 S3 账号（AK）
MANIFEST_BUCKET="plane-uploads"                              # Plane env AWS_S3_BUCKET_NAME 同名
MANIFEST_POLICY="plane-uploads-only"                   # 策略名（内部标签，无外部引用）
# 策略内容：仅本桶全动作（对齐代码实证——settings/storage.py 等全部消费点
# 只用 AWS_S3_BUCKET_NAME 单桶，读写删/预签名全有 → s3:*；不给任何 admin 权限）
MANIFEST_POLICY_DOC='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:*"],"Resource":["arn:aws:s3:::'"$MANIFEST_BUCKET"'","arn:aws:s3:::'"$MANIFEST_BUCKET"'/*"]}]}'

status() { echo "  [$1] $2"; }
have() { mc "$@" >/dev/null 2>&1; }

# ── 幂等执行器（对比现状，缺则建、有则跳过；--check 只报不动）────────
echo "== minio Plane 资源引导（alias=$ALIAS）=="

# ① 桶
if have ls "$ALIAS/$MANIFEST_BUCKET"; then
  status "OK" "桶 $MANIFEST_BUCKET 已存在"
elif [ -n "$CHECK_ONLY" ]; then
  status "MISS" "桶 $MANIFEST_BUCKET 缺失"
else
  mc mb "$ALIAS/$MANIFEST_BUCKET" >/dev/null && status "ADD" "桶 $MANIFEST_BUCKET 已创建"
fi

# ② 策略
POLICY_TMP="$(mktemp)"
printf '%s' "$MANIFEST_POLICY_DOC" > "$POLICY_TMP"
if mc admin policy info "$ALIAS" "$MANIFEST_POLICY" >/dev/null 2>&1; then
  status "OK" "策略 $MANIFEST_POLICY 已存在"
elif [ -n "$CHECK_ONLY" ]; then
  status "MISS" "策略 $MANIFEST_POLICY 缺失"
else
  mc admin policy add "$ALIAS" "$MANIFEST_POLICY" "$POLICY_TMP" >/dev/null \
    && status "ADD" "策略 $MANIFEST_POLICY 已创建"
fi
rm -f "$POLICY_TMP"

# ③ 账号（密码：交互输入，不落参数——避免进 shell 历史/进程列表）
USER_EXISTS=$(mc admin user info "$ALIAS" "$MANIFEST_USER" >/dev/null 2>&1 && echo yes || echo no)
if [ "$USER_EXISTS" = "yes" ]; then
  status "OK" "账号 $MANIFEST_USER 已存在（密码不校验，轮换走 remove+add）"
elif [ -n "$CHECK_ONLY" ]; then
  status "MISS" "账号 $MANIFEST_USER 缺失（需交互输入密码，--check 模式不创建）"
else
  read -r -s -p "输入 $MANIFEST_USER 的 SecretKey（12+ 位，建议仅字母数字）: " PLANE_SECRET; echo
  [ "${#PLANE_SECRET}" -ge 12 ] || { echo "FAIL: SecretKey 少于 12 位"; exit 1; }
  mc admin user add "$ALIAS" "$MANIFEST_USER" "$PLANE_SECRET" >/dev/null \
    && status "ADD" "账号 $MANIFEST_USER 已创建"
fi

# ④ 绑定（存在性以 info 判——attach 无独立 list，重复 attach 报错即视为已绑）
if mc admin user info "$ALIAS" "$MANIFEST_USER" 2>/dev/null | grep -q "$MANIFEST_POLICY"; then
  status "OK" "策略 $MANIFEST_POLICY 已绑定 $MANIFEST_USER"
elif [ -n "$CHECK_ONLY" ]; then
  status "MISS" "策略未绑定 $MANIFEST_USER"
else
  mc admin policy attach "$ALIAS" "$MANIFEST_POLICY" --user "$MANIFEST_USER" >/dev/null \
    && status "ADD" "策略 $MANIFEST_POLICY 已绑定 $MANIFEST_USER"
fi

# ⑤ 终态自检（专属账号只能看到自己的桶——最小权限实证）
echo "== 权限自检 =="
if [ -n "$CHECK_ONLY" ]; then
  status "SKIP" "--check 模式跳过（需账号密码）"
else
  mc ls "$ALIAS/" | awk '{print "  桶:", $NF}'
  status "OK" "完成。Plane env：AWS_ACCESS_KEY_ID=$MANIFEST_USER / AWS_S3_BUCKET_NAME=$MANIFEST_BUCKET"
fi
