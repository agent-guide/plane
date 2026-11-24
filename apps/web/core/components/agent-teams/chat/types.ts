/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file in the repository root for more details.
 *
 * 数字员工会话（P2 一期）——共享类型。仅类型与纯函数，无副作用。
 */
import type { AgentMessage } from "@/services/agent-teams/agent-chat.service";
import type { ChatMessage, ChatSession } from "@/services/agent-teams/chat.service";

export type { AgentMessage, ChatMessage, ChatSession };

/** 流式中的员工回复（首字前的等待态 / 增量 / 阶段进度 / 错误）。 */
export type StreamingAssistant = {
  id: string;
  text: string;
  sourceCount: number;
  /** 协议 v2 进度透传：当前阶段（单行「正在…」），done 后清空 */
  stage?: { phase: "tool" | "plan"; label: string; out?: string } | null;
  error?: StreamError;
};

/** D1 归一化错误（checkpoint=T1 预算检查点三选）。 */
export type StreamError = {
  code: string;
  detail?: string;
  checkpoint?: boolean;
  options?: string[];
};

/** 深链参数（成员行「发起对话」携带）。 */
export type ChatDeepLink = {
  /** 名册成员 id（建会话/匹配已有会话） */
  member?: string;
  /** agent 定义 id（旧式深链按此匹配） */
  expert?: string;
  /** 团队 id（二级上下文） */
  team?: string;
  /** 成员显示名（新建会话标题） */
  name?: string;
};

/**
 * 选中态机（纯函数，可单测）：由列表 + 深链 + 当前选中推导下一选中。
 *
 * 三级不变量：
 * - 深链（member/expert）→ 匹配已有会话（跨团队允许——深链即意图）
 * - 二级（team）→ 选中必须属于当前团队；不属于（含空）→ 团队首个
 * - 一级（无 team）→ 永不选中
 */
export function deriveActiveSession(
  sessions: ChatSession[],
  link: ChatDeepLink,
  currentActiveId: string
): { nextActiveId: string; sessionToCreate?: { teamId: string; agentMemberId: string; title?: string } } {
  if (link.member || link.expert) {
    const existing = sessions.find((s) => (link.member ? s.agentMemberId === link.member : s.expertId === link.expert));
    if (existing) return { nextActiveId: existing.id };
    if (link.member && link.team) {
      return {
        nextActiveId: "",
        sessionToCreate: { teamId: link.team, agentMemberId: link.member, title: link.name },
      };
    }
    return { nextActiveId: currentActiveId };
  }
  if (link.team) {
    const belongsToTeam = sessions.some((s) => s.id === currentActiveId && s.teamId === link.team);
    if (belongsToTeam) return { nextActiveId: currentActiveId };
    const first = sessions.find((s) => s.teamId === link.team);
    return { nextActiveId: first?.id ?? "" };
  }
  return { nextActiveId: "" };
}

/** 会话按团队聚合（一级团队折叠列表数据源）。 */
export function groupSessionsByTeam(
  sessions: ChatSession[]
): { teamId: string; teamName: string; sessions: ChatSession[]; unread: number; latestPreview: string }[] {
  const groups = new Map<string, { teamId: string; teamName: string; sessions: ChatSession[]; unread: number }>();
  for (const session of sessions) {
    const g = groups.get(session.teamId) ?? {
      teamId: session.teamId,
      teamName: session.teamName,
      sessions: [],
      unread: 0,
    };
    g.sessions.push(session);
    if (session.unread) g.unread += 1;
    groups.set(session.teamId, g);
  }
  const result: { teamId: string; teamName: string; sessions: ChatSession[]; unread: number; latestPreview: string }[] =
    [];
  for (const g of groups.values()) {
    // 最近活跃会话（lastMessageAt 降序首个）；preview 即列表副行
    const latest = g.sessions.reduce<ChatSession | undefined>((acc, s) => {
      if (!s.lastMessagePreview) return acc;
      if (!acc || (s.lastMessageAt ?? "") > (acc.lastMessageAt ?? "")) return s;
      return acc;
    }, undefined);
    result.push({
      teamId: g.teamId,
      teamName: g.teamName,
      sessions: g.sessions,
      unread: g.unread,
      latestPreview: latest?.lastMessagePreview ?? "",
    });
  }
  return result;
}
