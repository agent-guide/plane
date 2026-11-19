# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""附件解析（兼容转发）：权威实现已提升至仓库级 packages/document-parsing
（与 services/doc-mcp 的 parse_document 工具共用同一实现，防解析行为漂移）。
本模块保留原导入路径（execution_context/tests 引用不变），仅 re-export。
"""
from document_parsing import parse_attachment_bytes, parse_attachment_url

__all__ = ["parse_attachment_bytes", "parse_attachment_url"]
