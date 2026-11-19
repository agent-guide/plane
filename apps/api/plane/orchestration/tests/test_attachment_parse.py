# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""附件解析（P3 一期「文档类」）纯函数测试：按扩展名把文档字节转纯文本。

覆盖 txt/md/csv 直读、docx/xlsx/pptx 定向库解析、pdf 文本提取、不支持类型抛错、
字符预算截断（docs/v2/attachment-parsing-design.md §4/§5.4）。"""

import io
from unittest import TestCase

from plane.orchestration.attachment_parse import parse_attachment_bytes, parse_attachment_url


class ParseAttachmentBytesTest(TestCase):
    def test_txt_utf8(self):
        self.assertEqual(parse_attachment_bytes("a.txt", "你好 world".encode("utf-8")), "你好 world")

    def test_txt_gbk_fallback(self):
        # utf-8 解码失败 → gbk 回退
        self.assertEqual(parse_attachment_bytes("a.txt", "毛重".encode("gbk")), "毛重")

    def test_md_and_csv_direct_read(self):
        self.assertEqual(parse_attachment_bytes("a.md", "# 标题\n正文".encode("utf-8")), "# 标题\n正文")
        self.assertEqual(parse_attachment_bytes("a.csv", "a,b\n1,2\n".encode("utf-8")), "a,b\n1,2\n")

    def test_html_extracts_body_without_resource_urls(self):
        # 网页保存件带 <link>/<script> 资源 URL——须抽正文，否则 agent 误当链接去读
        html = (
            "<!DOCTYPE html><html><head>"
            '<link rel="stylesheet" href="http://223.105.56.202:4004/assets/app.css">'
            '<script src="http://223.105.56.202:4004/app.js"></script>'
            "</head><body>"
            "<h1>出口报关单</h1><p>境内收发货人：912473XNKR4774</p>"
            '<a href="http://223.105.56.202:4004/v2-e2e/browse/ENTRYAPI-17/">链接</a>'
            "</body></html>"
        )
        out = parse_attachment_bytes("a.html", html.encode("utf-8"))
        self.assertIn("出口报关单", out)
        self.assertIn("境内收发货人：912473XNKR4774", out)
        self.assertNotIn("http://223.105.56.202", out)
        self.assertNotIn("<script", out)
        self.assertNotIn("<h1>", out)

    def test_docx_paragraphs(self):
        import docx
        d = docx.Document()
        d.add_paragraph("段落一")
        d.add_paragraph("段落二 含中文")
        buf = io.BytesIO()
        d.save(buf)
        self.assertEqual(parse_attachment_bytes("a.docx", buf.getvalue()), "段落一\n段落二 含中文")

    def test_xlsx_rows_joined(self):
        import openpyxl
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = "数据"
        ws.append(["列A", "列B"])
        ws.append([1, "x"])
        buf = io.BytesIO()
        wb.save(buf)
        out = parse_attachment_bytes("a.xlsx", buf.getvalue())
        self.assertIn("工作表：数据", out)
        self.assertIn("列A | 列B", out)
        self.assertIn("1 | x", out)

    def test_pptx_slides(self):
        from pptx import Presentation
        prs = Presentation()
        slide = prs.slides.add_slide(prs.slide_layouts[5])
        slide.shapes.title.text = "标题页"
        buf = io.BytesIO()
        prs.save(buf)
        out = parse_attachment_bytes("a.pptx", buf.getvalue())
        self.assertIn("第 1 页", out)
        self.assertIn("标题页", out)

    def test_pdf_text_extraction(self):
        # 空白页 pdf 提取出空文本（不抛错）
        from pypdf import PdfWriter
        w = PdfWriter()
        w.add_blank_page(width=200, height=200)
        buf = io.BytesIO()
        w.write(buf)
        self.assertEqual(parse_attachment_bytes("a.pdf", buf.getvalue()), "")

    def test_unsupported_type_raises(self):
        with self.assertRaises(ValueError):
            parse_attachment_bytes("a.png", b"\x89PNG")
        with self.assertRaises(ValueError):
            parse_attachment_bytes("noext", b"data")

    def test_corrupt_docx_raises(self):
        """损坏的 docx（非 zip 字节）→ 抛异常，由上层 _attachment_texts 捕获降级。"""
        with self.assertRaises(Exception):
            parse_attachment_bytes("a.docx", b"not a real docx zip")


class ParseAttachmentUrlTest(TestCase):
    def test_truncates_over_budget(self):
        text, truncated = parse_attachment_url("a.txt", ("x" * 100).encode("utf-8"), max_chars=10)
        self.assertEqual(len(text), 10)
        self.assertTrue(truncated)

    def test_no_truncation_within_budget(self):
        text, truncated = parse_attachment_url("a.txt", "short".encode("utf-8"), max_chars=100)
        self.assertEqual(text, "short")
        self.assertFalse(truncated)
