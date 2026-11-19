# doc-mcp（文档解析 MCP 工具）

设计 [docs/v2/document-parsing-and-email-capability.md](../../../docs/v2/) §二。
`parse_document(content_base64+filename | url) → {text, filename, mime_type, truncated}`。

- 定位：**agent 主动解析的兜底**——用户上传的文件走平台自动解析注入（四种场景），
  本工具服务「agent 通过工具主动拿到、未被平台解析」的文件（邮件附件、未来
  文件产物/知识库文档）
- 解析实现来自 `packages/document-parsing`（**单一权威源**，与 plane 编排域
  注入共用，agent 主动解析的结果与平台自动注入一致，防行为漂移）
- 安全：url 输入 SSRF 防护（IP 直连先查 + DNS 后拒私网，标准库 ipaddress）；
  base64 限 10MB；解析超时 30s；文本截断 20k chars；不支持图片 OCR
- 工具描述是 prompt 工程的一部分（何时调/不对已注入附件调），改动需评估
  agent 行为影响
- 部署：`scripts/local/up.sh` ④（:8625，node 版本自适应不适用——Python 服务，
  依赖 venv）；注册 `scripts/bootstrap-doc-parser.sh`；巡检 `check.sh`

## 运行

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python server.py   # PORT 默认 8625
```
