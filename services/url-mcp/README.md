# url-mcp（链接读取 MCP 工具）

任务③「链接解析」工具侧实现（设计 docs/v2/link-and-file-artifacts-design.md §一）。
`url_reader(url)`：抓网页抽正文（去 script/style），SSRF 防护（IP 直连与 DNS
解析后均拒私网）、2MB/20k chars/8s 限制、Content-Type 白名单。

## 实现形态（TS 单源，直跑）

- **唯一实现是 server.ts**：node ≥23 原生 type stripping 直跑
  （`node server.ts`），**运行零依赖零构建**；类型检查 `npm run typecheck`
  （typescript/@types/node 仅 devDependencies）。
- 演进说明：最初并存 bun 专用版（Bun.serve/Bun.DNS，node 跑不了）与 node
  手写版 server.mjs 两份实现，改动只落一份造成漂移，收敛为 TS 单源。
- 工具描述（何时调用/不对附件调用）是 prompt 工程的一部分，改动需评估
  agent 行为影响（曾因描述未排除附件，agent 对 .html 保存件误调）。

## 部署

- 随栈拉起：`scripts/local/up.sh` ③（:8624）；停止 `down.sh`；巡检 `check.sh`
- 平台链注册：`scripts/bootstrap-url-reader.sh`（幂等；provision.sh ⑥ 调用）
- 员工绑定：管理端改稿勾选 url_reader → 发布 release → 部署升级（脚本仅报告）
