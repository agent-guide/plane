# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""附件解析（P3 文档类一期）：把工作卡评论附件的内容转成纯文本，供数字员工
读取（业界同构：Dify Document Extractor 节点 / Coze 文件解析）。

选型说明（2026-11-12）：用轻量定向库（pypdf / python-docx / openpyxl /
python-pptx）而非 markitdown——markitdown 经 magika 拉 onnxruntime、经
pdfplumber 拉 pandas，部署体积过重；本模块覆盖业务实际需要的文档类即可。
图片 OCR（含扫描件 pdf）不在本模块范围（需 vision 模型路由，挂二期）。
"""

from __future__ import annotations

import io


def parse_attachment_bytes(filename: str, data: bytes) -> str:
    """按扩展名解析附件字节为纯文本。

    - 文本类（txt/md/csv/html/json/xml/log）：直接按文本读（utf-8 → gbk → latin-1 回退）
    - pdf：pypdf 提取文本（扫描件 pdf 提不出文本，返回空——由调用方标注「图片需人工」）
    - docx：python-docx 段落文本
    - xlsx/xls：openpyxl 逐表转文本（行内单元格以 ``|`` 分隔）
    - pptx：python-pptx 逐页提取形状文本

    Raises:
        ValueError: 不支持的扩展名（图片/音频/未知类型）。
    """
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""

    if ext in {"txt", "md", "markdown", "csv", "html", "htm", "json", "xml", "log", "yaml", "yml"}:
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
