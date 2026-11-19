/**
 * MCP 工具模块契约：每个工具一个实现（tools/*.ts），导出一个 McpTool。
 * 新增通用工具 = 新建 tools/xxx.ts + 在 server.ts 的 TOOLS 注册表加一行；
 * 协议层（server.ts）与部署链（up/down/check/bootstrap）不用动。
 * description 是 prompt 工程的一部分（agent 据此决定何时调用），改动需
 * 评估对 agent 行为的影响，勿随意措辞。
 */
export interface McpTool {
  /** 工具名（平台链 stable id 组成部分：mcp:<connector>:<name>，改名=断链） */
  name: string;
  /** 给 agent 看的调用时机说明（prompt 工程的一部分） */
  description: string;
  /** JSON Schema 入参定义（tools/list 暴露） */
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
  /** 执行：抛错 = MCP isError（错误 message 会回传给 agent 与前端） */
  run(args: Record<string, unknown>): Promise<unknown>;
}
