/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file in the repository root for more details.
 *
 * 数字员工会话服务（P2 agent chat，设计 v2/team-assistant-chat-design.md）。
 * 走编排域同源 API；发消息返回 SSE 流（fetch streaming 手工解析——POST
 * 即流式响应，与编排域其余 service 的 request 形态同源）。
 */

export interface AgentConversation {
  id: string;
  teamId: string;
  teamName: string;
  agentMemberId: string;
  agentDefinitionId: string;
  agentName: string;
  agentRole: string;
  title: string;
  summaryCompacted: boolean;
  lastMessageAt: string | null;
  lastMessagePreview: string;
  /** 最后一条消息的错误结构（预览与会话页共用 displayErrorDetail 渲染） */
  lastMessageError?: { code: string; detail?: string } | null;
  unread: boolean;
  member?: { kind: string; role: string; displayName: string; enabled: boolean };
}

export type AgentMessageKind = "text" | "task" | "confirm_card" | "flow_card";

export interface AgentMessage {
  id: string;
  role: "user" | "agent" | "system";
  kind: AgentMessageKind;
  content: {
    text?: string;
    error?: { code: string; detail?: string; checkpoint?: boolean; options?: string[] };
    checkpoint?: boolean;
    interrupted?: boolean;
    /** 分享回执（Slack forwarded-to 模式）：本条消息分享到了哪些卡 */
    sharedTo?: { issueId: string; projectId: string; title: string; at: string }[];
    confirm?: { title: string; description: string; workflowHint?: string; state?: string; issueId?: string };
    card?: { issueId: string; projectId?: string; title: string; status: string };
  };
  attachments: { id: string; name: string; downloadUrl: string }[];
  streamingOffset: number;
  createdAt: string;
}

export type ChatStreamEvent =
  | { type: "delta"; text: string; messageId: string }
  | { type: "stage"; phase: "tool" | "plan"; label: string }
  | { type: "done"; messageId: string; userMessageId?: string; kind: AgentMessageKind; content: AgentMessage["content"]; stopReason?: string }
  | { type: "error"; code: string; detail?: string; checkpoint?: boolean; options?: string[] };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    let code = "";
    try {
      code = (await response.json())?.code ?? "";
    } catch {
      /* ignore parse errors */
    }
    throw new Error(`${response.status}${code ? ` ${code}` : ""}`);
  }
  return response.json();
}

export async function listConversations(workspaceSlug: string): Promise<AgentConversation[]> {
  return request(`/api/workspaces/${workspaceSlug}/agent-teams/conversations/`);
}

export async function createConversation(
  workspaceSlug: string,
  teamId: string,
  agentMemberId: string
): Promise<AgentConversation> {
  return request(`/api/workspaces/${workspaceSlug}/agent-teams/conversations/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ teamId, agentMemberId }),
  });
}

export async function markConversationRead(workspaceSlug: string, conversationId: string): Promise<void> {
  await request(`/api/workspaces/${workspaceSlug}/agent-teams/conversations/${conversationId}/`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ markRead: true }),
  });
}

export async function deleteConversation(workspaceSlug: string, conversationId: string): Promise<void> {
  await request(`/api/workspaces/${workspaceSlug}/agent-teams/conversations/${conversationId}/`, {
    method: "DELETE",
  });
}

export async function listMessages(
  workspaceSlug: string,
  conversationId: string,
  before?: string
): Promise<AgentMessage[]> {
  const q = before ? `?before=${encodeURIComponent(before)}` : "";
  return request(`/api/workspaces/${workspaceSlug}/agent-teams/conversations/${conversationId}/messages/${q}`);
}

export async function confirmCard(
  workspaceSlug: string,
  conversationId: string,
  messageId: string,
  action: "confirm" | "cancel",
  projectId: string
): Promise<{ state: string; issueId?: string; confirmedCard?: AgentMessage; flowCard?: AgentMessage }> {
  return request<{ state: string; issueId?: string; confirmedCard?: AgentMessage; flowCard?: AgentMessage }>(
    `/api/workspaces/${workspaceSlug}/agent-teams/conversations/${conversationId}/messages/${messageId}/confirm/`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, projectId }),
    }
  ).catch(async (err) => {
    // 透传错误码（409 三种：已决/多项目/未绑定），供前端出准确文案
    if (err instanceof Error) {
      try {
        const resp = await (err as unknown as { response?: Response }).response?.json?.();
        if (resp?.code) throw new Error(`${err.message} ${resp.code}`);
      } catch {
        /* 保持原样 */
      }
    }
    throw err;
  });
}

/** 发消息并消费 SSE 流（POST 即流式响应；AbortSignal 取消=关流）。 */
export async function sendMessage(
  workspaceSlug: string,
  conversationId: string,
  text: string,
  attachmentIds: string[],
  onEvent: (event: ChatStreamEvent) => void,
  signal?: AbortSignal,
  webSearch = false
): Promise<void> {
  const response = await fetch(
    `/api/workspaces/${workspaceSlug}/agent-teams/conversations/${conversationId}/messages/`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, attachment_ids: attachmentIds, web_search: webSearch }),
      signal,
    }
  );
  if (!response.ok || !response.body) throw new Error(`${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // SSE 流读取是顺序语义（逐帧消费），await 在循环内是必须而非可并行化——
  // no-await-in-loop 误报，豁免。
  /* eslint-disable no-await-in-loop */
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    // SSE 帧以空行分隔；event:/data: 两行成帧
    while ((sep = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let type = "";
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event: ")) type = line.slice(7).trim();
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (!type || !data) continue;
      try {
        const obj = JSON.parse(data);
        if (type === "delta") onEvent({ type: "delta", text: obj.text ?? "", messageId: obj.messageId });
        else if (type === "stage") onEvent({ type: "stage", phase: obj.phase ?? "tool", label: obj.label ?? "" });
        else if (type === "done")
          onEvent({
            type: "done",
            messageId: obj.messageId,
            userMessageId: obj.userMessageId,
            kind: obj.kind,
            content: obj.content ?? {},
            stopReason: obj.stopReason,
          });
        else if (type === "error")
          onEvent({
            type: "error",
            code: obj.code ?? "agent_error",
            detail: obj.detail,
            checkpoint: obj.checkpoint,
            options: obj.options,
          });
      } catch {
        /* 忽略残帧 */
      }
    }
  }
}

export async function shareMessageToCard(
  workspaceSlug: string,
  conversationId: string,
  messageId: string,
  issueId: string
): Promise<{ commentId: string; issueId: string; issueName: string; sharedMessage?: AgentMessage }> {
  const response = await fetch(
    `/api/workspaces/${workspaceSlug}/agent-teams/conversations/${conversationId}/messages/${messageId}/share/`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issueId }),
    }
  );
  if (!response.ok) throw new Error(`${response.status}`);
  return response.json();
}
