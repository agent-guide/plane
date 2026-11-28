# plane-api 镜像 —— api 与 worker（procrastinate）共用，不同 command。
# 设计 docs/v2/aliyun-plane-stack-deploy-plan.md §四。
# 构建上下文必须是仓库根（需 packages/document-parsing）：
#   podman build -f apps/api/Dockerfile -t plane-api:vN .
FROM python:3.12-slim AS runtime

# uv：锁定依赖安装（pyproject + uv.lock 可复现构建）。
# 从 PyPI 装而非 ghcr.io——境外镜像仓国内拉取不稳，PyPI 走国内源稳；
# 版本由 pyproject required-version 钉死（0.12.21）
ARG PYPI_MIRROR=https://mirrors.aliyun.com/pypi/simple/
RUN pip install --no-cache-dir -i "$PYPI_MIRROR" uv==0.12.21

WORKDIR /app
ENV UV_PROJECT_ENVIRONMENT=/app/.venv \
    UV_LINK_MODE=copy \
    PYTHONUNBUFFERED=1

# 依赖层（先于代码拷贝，最大化层缓存命中）
# document-parsing 必须先就位：api 的可编辑路径依赖 ../../packages/document-parsing
# （deploy-v2.sh L111 实证坑：解析包未就位 → 依赖安装必失败）
COPY packages/document-parsing /app/packages/document-parsing
COPY apps/api/pyproject.toml apps/api/uv.lock /app/apps/api/
RUN cd /app/apps/api && UV_DEFAULT_INDEX="$PYPI_MIRROR" uv sync --frozen --no-install-project --no-dev

# 应用代码层
COPY apps/api /app/apps/api
RUN cd /app/apps/api && UV_DEFAULT_INDEX="$PYPI_MIRROR" uv sync --frozen --no-install-project --no-dev

WORKDIR /app/apps/api
ENV PATH="/app/.venv/bin:$PATH"
# DJANGO_SETTINGS_MODULE 不设：manage.py 默认即 plane.settings.production，
# 与测试服运行态一致（deploy-v2.sh L121 注释口径——不额外设）

EXPOSE 8000
# 与测试服形态一致：runserver（api 有 SSE 流式；gunicorn 属行为变更，后续独立评估）
CMD ["python", "manage.py", "runserver", "0.0.0.0:8000"]
