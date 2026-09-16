/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Extracted VERBATIM from the retired user app's dialogue page (frontend
 * migration, backend reused as-is). Pure stream-parsing & trace helpers —
 * no framework/app dependencies, shared by the Plane chat page.
 */

const chineseSectionNumber = "[一二三四五六七八九十]+";
const inlineSubheadingPattern =
  "(核心关键词|长尾关键词|场景词|竞品词|标题结构|标题建议|标题公式|示例方向|五点卖点建议|五点描述|卖点描述|图片\\/A\\+重点|Search Terms|图片和视频|合规提醒|广告策略|预算建议|落地步骤)";
const sellingPointPattern = "(第一条|第二条|第三条|第四条|第五条)";
export const STREAM_IDLE_TIMEOUT_MS = 180_000;

export type AssistantTraceItem = {
  kind: "thinking" | "action";
  text: string;
  id?: string;
};

function stripControlMarkers(text: string) {
  return text
    .replace(/\[\/?(tool|tool_call|tool_result|function|function_call|assistant|system|user)\b[^\]]*\]/gi, "")
    .replace(/<\/?(tool|tool_call|tool_result|function|function_call)\b[^>]*>/gi, "");
}

function stripWrappingMarkdown(text: string) {
  return text
    .trim()
    .replace(/^\*\*([\s\S]+)\*\*$/, "$1")
    .replace(/^__([\s\S]+)__$/, "$1")
    .trim();
}

function cleanInlineText(text: string) {
  return text.replace(/\*\*/g, "").replace(/__/g, "");
}

function splitDenseNumberedItems(line: string) {
  const trimmed = line.trim();
  if (/^\\?#{1,6}\s*.+/.test(trimmed)) {
    return [trimmed];
  }

  return line
    .replace(new RegExp(`\\*\\*(${chineseSectionNumber}[、.]\\s*[^*\\n]{2,40}?)\\*\\*`, "g"), "\n$1\n")
    .replace(new RegExp(`__(${chineseSectionNumber}[、.]\\s*[^_\\n]{2,40}?)__`, "g"), "\n$1\n")
    .replace(new RegExp(`([^\\n])\\s*(?=(${chineseSectionNumber}[、.]\\s*))`, "g"), "$1\n")
    .replace(/\s+(?=\d+[.)]\s+)/g, "\n")
    .replace(new RegExp(`\\s+(?=(${inlineSubheadingPattern})[:：])`, "gi"), "\n")
    .replace(new RegExp(`\\s+(?=(${sellingPointPattern}写))`, "g"), "\n")
    .replace(/\s+(?=(核心原则|核心建议|建议|结论|执行方案|营销策略|Listing\s*策略))/gi, "\n")
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function normalizeMarkdownForDisplay(text: string) {
  const normalized = stripControlMarkers(text).replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return "正在思考...";
  }

  const output: string[] = [];
  const codeLines: string[] = [];
  let inCodeBlock = false;

  for (const sourceLine of normalized.split("\n")) {
    const sourceTrimmed = sourceLine.trim();

    if (sourceTrimmed.startsWith("```")) {
      if (inCodeBlock) {
        output.push(codeLines.join("\n"));
        codeLines.length = 0;
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      output.push(sourceLine);
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(sourceLine);
      continue;
    }

    const lines = sourceTrimmed ? splitDenseNumberedItems(sourceLine) : [""];

    for (const rawLine of lines) {
      const line = rawLine.trim();

      if (!line || isTracePlaceholder(line)) {
        output.push("");
        continue;
      }

      const markdownHeading = line.match(/^\\?(#{1,6})\s*(.+)$/);
      if (markdownHeading) {
        // Always emit a space after the hashes so `#标题` (common in CN output) renders as a heading.
        output.push(`${markdownHeading[1]} ${stripWrappingMarkdown(markdownHeading[2])}`);
        continue;
      }

      const cleanLine = stripWrappingMarkdown(line);
      const chineseSection = cleanLine.match(
        new RegExp(`^(${chineseSectionNumber}[、.]\\s*[^:：，。,;；]{2,28}?)(?:\\s+(.+))?$`, "i")
      );
      if (chineseSection) {
        output.push(`## ${chineseSection[1].trim()}`);
        if (chineseSection[2]?.trim()) {
          output.push(normalizeInlineSubheading(chineseSection[2].trim()));
        }
        continue;
      }

      if (new RegExp(`^(${inlineSubheadingPattern})[:：]`, "i").test(line)) {
        output.push(normalizeInlineSubheading(line));
        continue;
      }

      const sellingPoint = line.match(new RegExp(`^(${sellingPointPattern}写[^，。,;；：:]{2,24})(?:\\s+(.+))?$`));
      if (sellingPoint) {
        const title = sellingPoint[1].trim();
        const rest = sellingPoint[2]?.trim();
        output.push(rest ? `- **${title}**：${cleanInlineText(rest)}` : `- **${title}**`);
        continue;
      }

      output.push(cleanInlineText(line));
    }
  }

  if (codeLines.length) {
    output.push(codeLines.join("\n"));
  }

  return compactSellingPointBlocks(compactAudienceTargetingBlocks(output))
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeInlineSubheading(text: string) {
  const inlineSubheading = text.match(new RegExp(`^(${inlineSubheadingPattern})[:：]\\s*(.*)$`, "i"));
  if (!inlineSubheading) return cleanInlineText(text);

  const rest = inlineSubheading[2]?.trim();
  return rest ? `### ${inlineSubheading[1]}：\n\n${cleanInlineText(rest)}` : `### ${inlineSubheading[1]}：`;
}

function compactAudienceTargetingBlocks(lines: string[]) {
  const compacted: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index]?.trim() ?? "";
    const next = lines[index + 1]?.trim() ?? "";

    if (isAudienceLabel(current) && isAudienceDescription(next)) {
      compacted.push(`- **${current}**：${next.replace(/^主打\s*/, "")}`);
      index += 1;
      continue;
    }

    compacted.push(lines[index]);
  }

  return compacted;
}

function isAudienceLabel(text: string) {
  if (!text || text.startsWith("#") || text.startsWith("- ") || text.length > 18) return false;
  return text.endsWith("人群");
}

function isAudienceDescription(text: string) {
  return /^主打\s+/.test(text);
}

export function mergeTraceText(current: string, incoming: string) {
  const next = incoming.trim();
  if (!next) return current;
  if (!current) return next;
  if (next === current || current.includes(next)) return current;
  if (next.includes(current)) return next;
  return `${current}${incoming}`;
}

function findLastTraceIndex(items: AssistantTraceItem[], kind: AssistantTraceItem["kind"]) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.kind === kind) return index;
  }

  return -1;
}

export function findTraceIndex(items: AssistantTraceItem[], item: AssistantTraceItem) {
  if (item.id) {
    return items.findIndex((trace) => trace.id === item.id);
  }

  const initialStatusIndex = items.findIndex((trace) => trace.id === "status:initial" && trace.kind === item.kind);
  if (initialStatusIndex >= 0) return initialStatusIndex;

  return findLastTraceIndex(items, item.kind);
}

export function isTracePlaceholder(text: string) {
  const value = text.trim();
  return value === "正在思考..." || value === "正在整理回答..." || value === "正在组织最终回答。";
}

export function appendUniqueTraceItems(target: AssistantTraceItem[], items: AssistantTraceItem[]) {
  items.forEach((item) => {
    const text = normalizeTraceText(item.text);
    if (!text || isTracePlaceholder(text)) return;

    if (item.id && target.some((existing) => existing.id === item.id && existing.text === text)) return;
    if (!item.id && target.some((existing) => existing.kind === item.kind && existing.text === text)) return;

    target.push({ ...item, text });
  });
}

export function normalizeTraceText(text: string) {
  const stripped = stripControlMarkers(text).replace(/\r\n/g, "\n").trim();
  if (!stripped || /^tool$/i.test(stripped)) return "";
  return stripped;
}

export function splitTraceText(text: string): AssistantTraceItem[] {
  return splitProcessSentences(text)
    .map(normalizeTraceText)
    .filter(Boolean)
    .map((line) => ({
      kind: /搜索|检索|读取|调用|查询|知识库|source|sources|工具|tool/i.test(line)
        ? ("action" as const)
        : ("thinking" as const),
      text: line,
    }));
}

function compactSellingPointBlocks(lines: string[]) {
  const compacted: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index]?.trim() ?? "";
    const next = lines[index + 1]?.trim() ?? "";

    if (
      /^-\s+\*\*(第一条|第二条|第三条|第四条|第五条)写/.test(current) &&
      next &&
      !next.startsWith("#") &&
      !next.startsWith("- ")
    ) {
      compacted.push(`${current}：${next}`);
      index += 1;
      continue;
    }

    compacted.push(lines[index]);
  }

  return compacted;
}

function splitProcessSentences(text: string) {
  return text
    .replace(/\r\n/g, "\n")
    .split(/(?<=[。！？.!?])\s+|\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function parseSseMessage(raw: string) {
  let event = "message";
  const data: string[] = [];

  raw.split("\n").forEach((line) => {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    }

    if (line.startsWith("data:")) {
      data.push(line.slice("data:".length).trimStart());
    }
  });

  return { event, data: data.join("\n") };
}

export function parseSseJson(data: string) {
  if (!data || data === "[DONE]") return null;

  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return { text: data };
  }
}

export function readTextDelta(payload: Record<string, unknown> | null) {
  if (!payload) return "";

  const candidates = [
    payload.text,
    payload.delta,
    (payload.delta as { content?: unknown; text?: unknown } | undefined)?.content,
    (payload.delta as { content?: unknown; text?: unknown } | undefined)?.text,
  ];

  const value = candidates.find((candidate) => typeof candidate === "string");
  return typeof value === "string" ? value : "";
}

export function readTraceText(payload: Record<string, unknown> | null) {
  if (!payload) return "";

  const candidates = [
    payload.text,
    payload.delta,
    payload.message,
    payload.output,
    payload.content,
    payload.name,
    (payload.delta as { content?: unknown; text?: unknown } | undefined)?.content,
    (payload.delta as { content?: unknown; text?: unknown } | undefined)?.text,
    (payload.data as { text?: unknown; message?: unknown; name?: unknown } | undefined)?.text,
    (payload.data as { text?: unknown; message?: unknown; name?: unknown } | undefined)?.message,
    (payload.data as { text?: unknown; message?: unknown; name?: unknown } | undefined)?.name,
  ];

  const value = candidates.find((candidate) => typeof candidate === "string");
  return typeof value === "string" ? value : "";
}

export function readToolProgress(payload: Record<string, unknown> | null): AssistantTraceItem | null {
  if (!payload) return null;

  const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : undefined;
  const status = typeof payload.status === "string" ? payload.status : "";
  const title = typeof payload.title === "string" ? payload.title : "";
  const label = inferToolProgressLabel(title, status);

  return {
    kind: "action",
    id: toolCallId ? `tool:${toolCallId}` : undefined,
    text: label,
  };
}

function inferToolProgressLabel(title: string, status: string) {
  const isCompleted = status === "completed" || status === "succeeded" || status === "success";
  const lowerTitle = title.toLowerCase();
  const isKnowledgeBase =
    lowerTitle.includes("knowledge") ||
    lowerTitle.includes("/usr/local/knowledge") ||
    lowerTitle.includes("knowledge-base") ||
    lowerTitle.includes("wiki");

  if (isKnowledgeBase) {
    return isCompleted ? "已完成知识库检索" : "正在检索知识库";
  }

  if (title) {
    return isCompleted ? "已完成工具执行" : "正在执行工具";
  }

  return isCompleted ? "已完成资料处理" : "正在处理资料";
}

export function readToolCallId(payload: Record<string, unknown> | null) {
  if (!payload) return "";

  const data =
    (payload.data as { id?: unknown; toolCallId?: unknown; tool_call_id?: unknown; callId?: unknown } | undefined) ??
    undefined;
  const candidates = [
    payload.toolCallId,
    payload.tool_call_id,
    payload.callId,
    payload.id,
    data?.id,
    data?.toolCallId,
    data?.tool_call_id,
    data?.callId,
  ];
  const value = candidates.find((candidate) => typeof candidate === "string" && candidate);
  return typeof value === "string" ? value : "";
}

export function readToolName(payload: Record<string, unknown> | null) {
  if (!payload) return "";

  const data =
    (payload.data as { title?: unknown; name?: unknown; toolName?: unknown; tool?: unknown } | undefined) ?? undefined;
  const toolObject = (payload.tool as { name?: unknown; title?: unknown } | undefined) ?? undefined;
  const candidates = [
    payload.title,
    payload.name,
    payload.toolName,
    toolObject?.title,
    toolObject?.name,
    data?.title,
    data?.name,
    data?.toolName,
    data?.tool,
  ];
  const value = candidates.find((candidate) => typeof candidate === "string" && candidate);
  return typeof value === "string" ? value.trim() : "";
}

// Map a tool event to a friendly label. Never surface the raw tool identifier (e.g. "tool").
function describeToolActivity(name: string, completed: boolean) {
  return inferToolProgressLabel(name, completed ? "completed" : "running");
}

export function buildToolTraceItem(payload: Record<string, unknown> | null, completed: boolean): AssistantTraceItem {
  const toolCallId = readToolCallId(payload);
  const toolName = readToolName(payload);
  const fallbackId = toolName ? `tool:fallback:${toolName.toLowerCase()}` : "tool:fallback:activity";

  return {
    kind: "action",
    id: toolCallId ? `tool:${toolCallId}` : fallbackId,
    text: describeToolActivity(toolName, completed),
  };
}

export function readSourceCount(payload: Record<string, unknown> | null) {
  if (!payload) return null;

  const documents = payload.documents || payload.sources || payload.citations;
  return Array.isArray(documents) ? documents.length : null;
}

export function readErrorMessage(payload: Record<string, unknown> | null) {
  if (!payload) return "";

  const candidates = [
    payload.message,
    payload.error,
    payload.detail,
    payload.reason,
    (payload.data as { message?: unknown; error?: unknown; detail?: unknown } | undefined)?.message,
    (payload.data as { message?: unknown; error?: unknown; detail?: unknown } | undefined)?.error,
    (payload.data as { message?: unknown; error?: unknown; detail?: unknown } | undefined)?.detail,
  ];

  const value = candidates.find((candidate) => typeof candidate === "string" && candidate.trim());
  return typeof value === "string" ? value.trim() : "";
}
