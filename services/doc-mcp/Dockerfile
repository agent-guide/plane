# doc-mcp 镜像（文档解析 MCP，:8625）。
# python + libreoffice（.doc/.ppt 高质量档；缺失则 olefile 兜底——镜像内直接带上，
# 不做降级）；共享解析包 packages/document-parsing 随镜像（api 同源单一权威）。
# requirements 内 `-e ../../packages/document-parsing` 为相对路径——镜像内
# 保持仓库目录结构（/repo/services/doc-mcp + /repo/packages）使其原样成立。
# 构建上下文必须是仓库根：
#   podman build -f services/doc-mcp/Dockerfile -t plane-doc-mcp:vN .
FROM python:3.12-slim

# libreoffice（headless）：doc/ppt 高质量解析引擎（deploy-v2.sh §doc-mcp 同款依赖）
RUN apt-get update \
    && apt-get install -y --no-install-recommends libreoffice-writer libreoffice-impress \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /repo/services/doc-mcp
COPY packages/document-parsing /repo/packages/document-parsing
COPY services/doc-mcp/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir --only-binary :all: Pillow==12.2.0 || true \
    && pip install --no-cache-dir -r requirements.txt

COPY services/doc-mcp /repo/services/doc-mcp
ENV PORT=8625
EXPOSE 8625
CMD ["python", "server.py"]
