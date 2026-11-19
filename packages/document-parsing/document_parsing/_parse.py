# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""解析实现（权威源，经 document_parsing 包对外暴露——背景与选型见包 __init__）。"""

from __future__ import annotations

import io
import re


def _html_to_text(raw: str) -> str:
    """HTML 源码 → 正文文本（去 script/style/注释/标签，保留段落换行）。

    与 url-mcp 的 extractHtml 同口径：网页保存件（.html）直接 decode 会带进
    几十条 <link>/<script> 资源 URL，agent 会误当成用户给的链接去读；这里抽
    正文，只留页面可读内容。
    """
    raw = re.sub(r"<script[\s\S]*?</script>", "", raw, flags=re.IGNORECASE)
    raw = re.sub(r"<style[\s\S]*?</style>", "", raw, flags=re.IGNORECASE)
    raw = re.sub(r"<!--[\s\S]*?-->", "", raw)
    raw = re.sub(r"<br\s*/?>", "\n", raw, flags=re.IGNORECASE)
    raw = re.sub(r"</(p|div|li|h[1-6]|tr|td|section)>", "\n", raw, flags=re.IGNORECASE)
    raw = re.sub(r"<[^>]+>", "", raw)
    raw = (raw.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<")
              .replace("&gt;", ">").replace("&quot;", '"').replace("&#39;", "'"))
    raw = re.sub(r"[ \t]+\n", "\n", raw)
    raw = re.sub(r"\n{3,}", "\n\n", raw)
    return raw.strip()


def parse_attachment_bytes(filename: str, data: bytes) -> str:
    """按扩展名解析附件字节为纯文本。

    - 文本类（txt/md/csv/json/xml/log）：直接按文本读（utf-8 → gbk → latin-1 回退）
    - html/htm：抽正文文本（去 script/style/标签与资源 URL），不直接返源码
    - pdf：pypdf 提取文本（扫描件 pdf 提不出文本，返回空——由调用方标注「图片需人工」）
    - docx：python-docx 段落文本
    - xlsx/xls：openpyxl 逐表转文本（行内单元格以 ``|`` 分隔）
    - pptx：python-pptx 逐页提取形状文本

    Raises:
        ValueError: 不支持的扩展名（图片/音频/未知类型）。
    """
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""

    if ext in {"html", "htm"}:
        for enc in ("utf-8", "gbk", "latin-1"):
            try:
                return _html_to_text(data.decode(enc))
            except UnicodeDecodeError:
                continue
        return _html_to_text(data.decode("utf-8", errors="replace"))

    if ext in {"txt", "md", "markdown", "csv", "json", "xml", "log", "yaml", "yml"}:
        for enc in ("utf-8", "gbk", "latin-1"):
            try:
                return data.decode(enc)
            except UnicodeDecodeError:
                continue
        return data.decode("utf-8", errors="replace")

    if ext == "pdf":
        from pypdf import PdfReader
        reader = PdfReader(io.BytesIO(data))
        pages = [(page.extract_text() or "").strip() for page in reader.pages]
        return "\n\n".join(pages)

    if ext == "docx":
        import docx
        document = docx.Document(io.BytesIO(data))
        return "\n".join(p.text for p in document.paragraphs)

    if ext in {"xlsx", "xls"}:
        import openpyxl
        workbook = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
        sheets = []
        for sheet in workbook.worksheets:
            rows = []
            for row in sheet.iter_rows(values_only=True):
                if all(c is None for c in row):
                    continue
                rows.append(" | ".join("" if c is None else str(c) for c in row))
            sheets.append(f"# 工作表：{sheet.title}\n" + "\n".join(rows))
        return "\n\n".join(sheets)

    if ext == "pptx":
        from pptx import Presentation
        prs = Presentation(io.BytesIO(data))
        slides = []
        for idx, slide in enumerate(prs.slides, 1):
            texts = []
            for shape in slide.shapes:
                if hasattr(shape, "text") and shape.text.strip():
                    texts.append(shape.text.strip())
            slides.append(f"# 第 {idx} 页\n" + "\n".join(texts))
        return "\n\n".join(slides)

    raise ValueError(f"unsupported attachment type: {ext or '(no extension)'}")


def parse_attachment_url(filename: str, data: bytes, *, max_chars: int = 8000) -> tuple[str, bool]:
    """解析附件并截断到字符预算。

    Returns:
        (text, truncated)：text 为截断后的文本，truncated 表示是否被截断。
    """
    text = parse_attachment_bytes(filename, data)
    if len(text) <= max_chars:
        return text, False
    return text[:max_chars], True
