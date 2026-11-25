/**
 * request_supplements — 执行中补料查询（11-25 终态设计 §三）。
 *
 * 替代长 URL curl（手抄事故根除）：短票据参数由任务指令提供，服务凭票据
 * 反查执行并返回结构化补充快照。查询是读快照不是等待机制——prompt 纪律
 * 已明确（hasNew=false 立即继续）。
 */
import type { McpTool } from "../tool.ts";

const PLANE_BASE = (process.env.PLANE_INTERNAL_BASE ?? "http://127.0.0.1:8001").replace(/\/$/, "");
const TOKEN = process.env.ORCHESTRATION_INTERNAL_TOKEN ?? "";

export const supplements: McpTool = {
  name: "request_supplements",
  description:
    "查询用户在任务执行期间有没有补充新信息（评论/附件）。每个主要阶段完成后调用一次；" +
    "返回 hasNew=false 说明无新增，立即继续既定流程。不要轮询等待。",
  inputSchema: {
    type: "object",
    properties: {
      ticket: { type: "string", description: "任务指令中给出的平台票据" },
    },
    required: ["ticket"],
  },
  async run(args) {
    const ticket = String(args.ticket ?? "").trim();
    if (!ticket) throw new Error("ticket required");
    const res = await fetch(`${PLANE_BASE}/api/internal/platform-tools/supplements/${encodeURIComponent(ticket)}`, {
      headers: { "X-Orchestration-Token": TOKEN },
    });
    if (res.status === 403) throw new Error("票据无效或已过期");
    if (!res.ok) throw new Error(`补料查询失败（${res.status}）`);
    const data = await res.json();
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  },
};
