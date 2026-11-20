# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""解析实现（权威源，经 document_parsing 包对外暴露——背景与选型见包 __init__）。"""

from __future__ import annotations

import io
import os
import re

import olefile
from olefile.olefile import NotOleFileError as _NotOleFileError


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

    if ext == "doc":
        return _extract_doc_text(data)

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

    if ext == "ppt":
        return _extract_ppt_text(data)

    if ext == "rtf":
        return _extract_rtf_text(data)

    if ext in {"odt", "ods", "odp"}:
        return _extract_odf_text(data, ext)

    raise ValueError(f"unsupported attachment type: {ext or '(no extension)'}")


# ─────────────────────────────────────────────────────────────────────────────
# 旧版 Office 二进制格式（.doc / .ppt）文本提取
#
# 双引擎：优先 LibreOffice headless（业界标准、中文准确），退回 olefile
# （纯 Python 零系统依赖、best effort——英文可靠、CJK 可能混格式噪音）。
# 部署要求：装了 LibreOffice 走高质量；没装走兜底，不报错不阻断。
# ─────────────────────────────────────────────────────────────────────────────

def _libreoffice_convert(data: bytes, ext: str) -> str | None:
    """用 LibreOffice headless 把 .doc/.ppt 转纯文本。不可用返回 None。"""
    import shutil, subprocess, tempfile, uuid
    soffice = shutil.which("soffice")
    if not soffice:
        return None
    tmpdir = tempfile.mkdtemp(prefix="doc-parse-")
    try:
        infile = f"{tmpdir}/{uuid.uuid4().hex}.{ext}"
        with open(infile, "wb") as f:
            f.write(data)
        result = subprocess.run(
            [soffice, "--headless", "--convert-to", "txt:Text", "--outdir", tmpdir, infile],
            capture_output=True, timeout=30,
        )
        txt_file = infile.rsplit(".", 1)[0] + ".txt"
        if result.returncode == 0 and os.path.exists(txt_file):
            with open(txt_file, "rb") as f:
                raw = f.read()
                # LibreOffice 输出可能带 UTF-8 BOM
                if raw.startswith(b"\xef\xbb\xbf"):
                    raw = raw[3:]
                return raw.decode("utf-8", errors="replace").strip() or None
        return None
    except Exception:
        return None
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def _extract_doc_text(data: bytes) -> str:
    """提取 .doc（Word 97-2003 二进制格式）文本。

    优先 LibreOffice（中文准确），退回 olefile 扫描（best effort）。
    """
    # 引擎 1：LibreOffice headless（高质量，需系统安装）
    text = _libreoffice_convert(data, "doc")
    if text:
        return text

    # 引擎 2：olefile 全文扫描（零依赖兜底，英文/数字可靠，CJK 可能不准）
    try:
        ole = olefile.OleFileIO(io.BytesIO(data))
    except _NotOleFileError:
        raise ValueError("not an OLE2 file (invalid .doc)")
    try:
        if not ole.exists("WordDocument"):
            raise ValueError("not a Word document (no WordDocument stream)")
        word_stream = ole.openstream("WordDocument").read()
    finally:
        ole.close()

    return _scan_readable_utf16(word_stream)


def _extract_ppt_text(data: bytes) -> str:
    """提取 .ppt（PowerPoint 97-2003 二进制格式）文本。

    优先 LibreOffice（中文准确），退回 olefile 记录扫描（纯 Python 兜底）。
    """
    # 引擎 1：LibreOffice headless
    text = _libreoffice_convert(data, "ppt")
    if text:
        return text

    # 引擎 2：olefile 逐记录扫描（TextCharsAtom / TextBytesAtom）
    import struct
    try:
        ole = olefile.OleFileIO(io.BytesIO(data))
    except _NotOleFileError:
        raise ValueError("not an OLE2 file (invalid .ppt)")
    try:
        if not ole.exists("PowerPoint Document"):
            raise ValueError("not a PowerPoint document (no PowerPoint Document stream)")
        ppt_stream = ole.openstream("PowerPoint Document").read()
    finally:
        ole.close()

    texts: list[str] = []
    pos = 0
    stream_len = len(ppt_stream)

    while pos + 8 <= stream_len:  # 每条记录头至少 8 字节（recVer/recInstance/recType/cbRec)
        rec_ver_inst, rec_type, rec_len = struct.unpack_from("<HHI", ppt_stream, pos)
        pos += 8  # 跳过记录头

        if rec_type == 0x0FA0:  # TextCharsAtom：UTF-16LE 文本
            text_bytes = ppt_stream[pos:pos + rec_len]
            if len(text_bytes) >= 2:
                try:
                    texts.append(text_bytes.decode("utf-16-le"))
                except UnicodeDecodeError:
                    pass
        elif rec_type == 0x0FA8:  # TextBytesAtom：ANSI/代码页文本
            text_bytes = ppt_stream[pos:pos + rec_len]
            if text_bytes:
                for enc in ("cp1252", "gbk", "latin-1"):
                    try:
                        texts.append(text_bytes.decode(enc))
                        break
                    except UnicodeDecodeError:
                        continue

        pos += rec_len  # 跳过记录体（含 container 子记录——不递归，按记录对齐扫描）

    if not texts:
        raise ValueError("no text records found in PowerPoint document")

    return "\n\n".join(t.strip() for t in texts if t.strip())


def _extract_rtf_text(data: bytes) -> str:
    """提取 .rtf（富文本格式）文本。

    RTF 是文本格式（带 \\ 控制码的 ASCII），优先 LibreOffice 高质量转换，
    退回简单的控制码剥离（保留可读文本段落）。
    """
    # 引擎 1：LibreOffice headless
    text = _libreoffice_convert(data, "rtf")
    if text:
        return text

    # 引擎 2：RTF 是带控制码的文本，剥离控制码保留可读内容
    decoded = data.decode("utf-8", errors="replace")
    # 去掉 \par（段落）和 \line（换行）之外的控制码
    decoded = re.sub(r"\\par[d]?\b", "\n", decoded)
    decoded = re.sub(r"\\line\b", "\n", decoded)
    decoded = re.sub(r"\\tab\b", "\t", decoded)
    # 去掉纯控制码（\word123 或 \word）
    decoded = re.sub(r"\\[a-z]+\d* ?", "", decoded, flags=re.IGNORECASE)
    # 去掉分组符和转义
    decoded = re.sub(r"[{}]", "", decoded)
    decoded = re.sub(r"\\'[0-9a-fA-F]{2}", "", decoded)
    # 压缩多余空行
    decoded = re.sub(r"\n{3,}", "\n\n", decoded).strip()
    if not decoded:
        raise ValueError("no readable text in RTF")
    return decoded


def _extract_odf_text(data: bytes, ext: str) -> str:
    """提取 OpenDocument（.odt/.ods/.odp）文本——仅 LibreOffice 引擎。

    ODF 是 ZIP+XML 容器，无轻量纯 Python 库；LibreOffice 是其原生格式，
    质量最高。LibreOffice 不可用时抛 ValueError（调用方标注「需人工查看」）。
    """
    text = _libreoffice_convert(data, ext)
    if not text:
        raise ValueError(f"LibreOffice unavailable to parse .{ext}")
    return text


def _scan_readable_utf16(data: bytes) -> str:
    """退化方案：扫描二进制数据中的 UTF-16LE 可读段。"""
    import struct
    segments: list[str] = []
    current: list[str] = []
    for i in range(0, len(data) - 1, 2):
        char_code = struct.unpack_from("<H", data, i)[0]
        char = chr(char_code)
        if char.isprintable() or char in "\n\r\t":
            current.append(char)
        else:
            if len(current) > 4:  # 只保留长度足够的段（过滤二进制噪音）
                segments.append("".join(current))
            current = []
    if len(current) > 4:
        segments.append("".join(current))
    if not segments:
        raise ValueError("no readable text found")
    return "\n".join(segments)


def parse_attachment_url(filename: str, data: bytes, *, max_chars: int = 8000) -> tuple[str, bool]:
    """解析附件并截断到字符预算。

    Returns:
        (text, truncated)：text 为截断后的文本，truncated 表示是否被截断。
    """
    text = parse_attachment_bytes(filename, data)
    if len(text) <= max_chars:
        return text, False
    return text[:max_chars], True
