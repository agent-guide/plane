# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""文档解析单一权威源（2026-11-19 从 plane orchestration/attachment_parse.py 提升）。

两个消费方共用同一份实现，防止解析行为漂移（agent 主动解析的结果必须与
平台自动注入的一致）：
- plane apps/api（编排域四处自动注入：会话/工作卡/评论/补料附件）
- services/doc-mcp（parse_document MCP 工具，agent 主动解析兜底）

选型说明（2026-11-12 定）：用轻量定向库（pypdf / python-docx / openpyxl /
python-pptx）而非 markitdown——markitdown 经 magika 拉 onnxruntime、经
pdfplumber 拉 pandas，部署体积过重。图片 OCR（含扫描件 pdf）不在本模块
范围（需 vision 模型路由，挂起）。
"""
from ._parse import parse_attachment_bytes, parse_attachment_url

__all__ = ["parse_attachment_bytes", "parse_attachment_url"]
