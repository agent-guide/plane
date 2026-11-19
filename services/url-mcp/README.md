# url-mcp（链接读取 MCP 工具）

任务③「链接解析」工具侧实现（设计 docs/v2/link-and-file-artifacts-design.md §一）。
`url_reader(url)`：抓网页抽正文（去 script/style），SSRF 防护（DNS 后拒私网）、
2MB/20k chars/8s 限制、Content-Type 白名单。

- **唯一实现是 server.mjs**（node ≥18 直跑，零构建零依赖）。
  曾有 server.ts（bun 版）双实现，已废弃不迁——双份必漂移（描述/日志改动只落
  mjs 一份就是实例）。
- 部署：`scripts/local/up.sh` 随栈拉起（:8624）；平台链注册
  `scripts/bootstrap-url-reader.sh`（幂等）；巡检 `scripts/local/check.sh`。
- 工具描述（何时调用/不对附件调用）是 prompt 工程的一部分，改动需评估对
  agent 行为的影响（曾因描述含糊导致 agent 对 .html 附件误调）。
