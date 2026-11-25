/**
 * request_human_input — in-turn 请求人工输入（11-25 终态设计 §二）。
 *
 * 对标 Claude Code AskUserQuestion：agent 调用后本工具阻塞等待用户在
 * 求助卡/审批收件箱作答，答复文本作为工具结果返回，agent 在同一 turn
 * 拿到答复继续（上下文无损）。阻塞上限 ASK_WAIT_MAX_MS（默认 55 分钟，
 * 低于 opencode 工具超时不确定上限；到点返回「尚未答复」由 agent 决定
 * 再调或收口——plane 侧求助 7 天上限语义不变）。
 */
import type { McpTool } from "../tool.ts";

const PLANE_BASE = (process.env.PLANE_INTERNAL_BASE ?? "http://127.0.0.1:8001").replace(/\/$/, "");
const TOKEN = process.env.ORCHESTRATION_INTERNAL_TOKEN ?? "";
const ASK_WAIT_MAX_MS = Number(process.env.ASK_WAIT_MAX_MS ?? 55 * 60_000);
const POLL_INTERVAL_MS = 3_000;

export const ask: McpTool = {
  name: "request_human_input",
  description:
    "缺少完成任务所必需的数据，或遇到必须用户拍板的矛盾（不确认就会做错）时调用。" +
    "调用后会等待用户答复，答复内容将作为结果返回——拿到后继续完成任务。" +
    "不要对已经回答过的问题重复调用。",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: "要问用户的问题，用业务语言说清楚缺什么/需要确认什么" },
      options: { type: "array", items: { type: "string" }, description: "可选：候选答案（用户点选或参考）" },
      ticket: { type: "string", description: "任务指令中给出的平台票据" },
    },
    required: ["question", "ticket"],
  },
  async run(args) {
    const ticket = String(args.ticket ?? "").trim();
    const question = String(args.question ?? "").trim();
    if (!ticket) throw new Error("ticket required");
    if (!question) throw new Error("question required");
    const options = Array.isArray(args.options) ? args.options.map(String).filter(Boolean) : undefined;
    // 登记求助（幂等）→ waiting 求助卡
    const reg = await fetch(`${PLANE_BASE}/api/internal/platform-tools/ask/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Orchestration-Token": TOKEN },
      body: JSON.stringify({ ticket, question, options }),
    });
    if (reg.status === 403) throw new Error("票据无效或已过期，请按任务指令中的当前票据调用");
    if (reg.status === 401) throw new Error("平台工具服务未授权（联系管理员）");
    if (!reg.ok) throw new Error(`求助登记失败（${reg.status}）`);
    // 阻塞轮询直至答复/上限
    const deadline = Date.now() + ASK_WAIT_MAX_MS;
    // 顺序轮询（每 3s 查一次状态）：等待-查询-判断是依赖链，Promise.all 不适用
    // eslint-disable-next-line no-await-in-loop
    while (Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      // eslint-disable-next-line no-await-in-loop
      const res = await fetch(`${PLANE_BASE}/api/internal/platform-tools/ask/${encodeURIComponent(ticket)}`, {
        headers: { "X-Orchestration-Token": TOKEN },
      });
      if (!res.ok) continue; // 瞬时错误：继续等
      // eslint-disable-next-line no-await-in-loop
      const data = (await res.json()) as { status: string; answer?: string };
      if (data.status === "answered") return { content: [{ type: "text", text: data.answer ?? "" }] };
      if (data.status === "none") throw new Error("求助记录不存在（可能已被终态收口），请按 NEED_INPUT 文本协议重问");
      // pending：继续等
    }
    return {
      content: [{ type: "text", text: "尚未收到答复（等待上限已到）。可再次调用本工具继续等待，或按任务情况收口。" }],
    };
  },
};
