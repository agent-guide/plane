/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file in the repository root for more details.
 *
 * 数字员工会话服务（P2 一期，2026-11-17 v2 重写）：
 * 对页面保持旧版（v1 experts 链）的接口形态——listSessions/createSession/
 * listMessages/streamTurn/setArchived——底层全部改走编排域 conversations
 * 端点（同源 /api、Plane 会话认证；experts-auth BFF 链退役）。
 * trace/来源/标题回调保留接口位（v2 网关暂不推送这些事件，agwmngr 支持
 * 后自动点亮，页面 UI 不变）。
 */
import {
  confirmCard as confirmCardApi,
  createConversation,
  deleteConversation,
  listConversations,
  listMessages,
  markConversationRead,
  sendMessage,
  type AgentConversation,
  type AgentMessage,
  type ChatStreamEvent,
} from "./agent-chat.service";

export type { AgentMessage };

/** 旧页会话形态（映射 v2 conversation）。 */
export type ChatSession = {
  id: string;
  title: string;
  expertId: string; // agent 定义 id（深链按此匹配已有会话）
  expertName: string | null;
  agentMemberId: string;
  teamId: string;
  teamName: string;
  unread: boolean;
  summaryCompacted: boolean;
  lastMessagePreview: string;
  lastMessageAt: string | null;
  member?: { kind: string; role: string; displayName: string; enabled: boolean };
};

export type ChatMessage = AgentMessage;

export type StreamTurnOptions = {
  signal?: AbortSignal;
  webSearchEnabled?: boolean;
  onToken: (token: string) => void;
  onTrace?: (item: unknown) => void; // v2 网关暂无 trace 事件；接口保留
  onSourceCount?: (count: number) => void; // 同上
  onTitle?: (title: string) => void; // v2 标题由会话 title 字段承载
  onError?: (normalized: { code: string; detail?: string; checkpoint?: boolean; options?: string[] }) => void;
};

function toSession(c: AgentConversation): ChatSession {
  return {
    id: c.id,
    title: c.title || c.agentName,
    expertId: c.agentDefinitionId,
    expertName: c.agentName,
    agentMemberId: c.agentMemberId,
    teamId: c.teamId,
    teamName: c.teamName,
    unread: c.unread,
    summaryCompacted: c.summaryCompacted,
    lastMessagePreview: c.lastMessagePreview,
    lastMessageAt: c.lastMessageAt,
    member: c.member,
  };
}

async function restoreConversation(workspaceSlug: string, conversationId: string): Promise<void> {
  const response = await fetch(`/api/workspaces/${workspaceSlug}/agent-teams/conversations/${conversationId}/`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ restore: true }),
  });
  if (!response.ok) throw new Error(`${response.status}`);
}

export const chatService = {
  /** 会话列表。view=archived 时查软删（归档）会话。 */
  async listSessions(workspaceSlug: string, view: "active" | "archived" = "active"): Promise<ChatSession[]> {
    const all = await listConversations(workspaceSlug);
    if (view === "archived") {
      // v2 列表端点默认只回活跃；归档经 ?archived=1 单独取
      const response = await fetch(
        `/api/workspaces/${workspaceSlug}/agent-teams/conversations/?archived=1`
      );
      if (!response.ok) return [];
      return ((await response.json()) as AgentConversation[]).map(toSession);
    }
    return all.map(toSession);
  },

  /** 建会话（v2：团队 + 名册成员）。 */
  async createSession(
    workspaceSlug: string,
    params: { teamId: string; agentMemberId: string; title?: string }
  ): Promise<ChatSession> {
    const c = await createConversation(workspaceSlug, params.teamId, params.agentMemberId);
    return toSession(c);
  },

  async listMessages(workspaceSlug: string, sessionId: string): Promise<ChatMessage[]> {
    return listMessages(workspaceSlug, sessionId);
  },

  /** 发消息并消费流（v2 帧协议）。 */
  async streamTurn(
    workspaceSlug: string,
    sessionId: string,
    content: string,
    opts: StreamTurnOptions,
    attachmentIds: string[] = []
  ): Promise<void> {
    await sendMessage(
      workspaceSlug,
      sessionId,
      content,
      attachmentIds,
      (event: ChatStreamEvent) => {
        if (event.type === "delta") opts.onToken(event.text);
        else if (event.type === "error") opts.onError?.(event);
      },
      opts.signal,
      Boolean(opts.webSearchEnabled)
    );
  },

  async setArchived(workspaceSlug: string, sessionId: string, archived: boolean): Promise<void> {
    if (archived) await deleteConversation(workspaceSlug, sessionId);
    else await restoreConversation(workspaceSlug, sessionId);
  },

  async markRead(workspaceSlug: string, sessionId: string): Promise<void> {
    await markConversationRead(workspaceSlug, sessionId);
  },

  async confirmCard(
    workspaceSlug: string,
    sessionId: string,
    messageId: string,
    action: "confirm" | "cancel",
    projectId?: string
  ): Promise<{ state: string; issueId?: string }> {
    return confirmCardApi(workspaceSlug, sessionId, messageId, action, projectId ?? "");
  },
};

export default chatService;
