/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file in the repository root for more details.
 *
 * 会话侧栏两级导航（微信折叠群聊同构）：
 * - TeamSidebar（一级）：团队折叠列表（未读聚合徽标），点击进二级
 * - ConversationSidebar（二级）：返回头 + 该团队会话列表（强选中态+未读点）
 */
import { useTranslation } from "@plane/i18n";
import { ArrowLeft } from "lucide-react";

import { MemberAvatar, TeamAvatar } from "@/components/agent-teams/member-avatar";
import { displayErrorDetail, type AgentErrorCode } from "@/services/agent-teams/orchestration.service";
import type { ChatSession } from "./types";
import { groupSessionsByTeam } from "./types";

export function TeamSidebar({
  sessions,
  loading,
  onOpenTeam,
}: {
  sessions: ChatSession[];
  loading: boolean;
  onOpenTeam: (teamId: string) => void;
}) {
  const { t } = useTranslation();
  const groups = groupSessionsByTeam(sessions);
  return (
    <aside className="w-full max-w-72 shrink-0 border-r border-subtle">
      <div className="flex flex-col">
        {loading && groups.length === 0 ? (
          <div className="p-4 text-body-sm-regular text-tertiary">{t("agent_teams_inbox_loading")}</div>
        ) : groups.length === 0 ? (
          <div className="px-4 py-8 text-center text-caption-sm-regular text-tertiary">
            {t("agent_teams_chat_empty_hint")}
          </div>
        ) : (
          groups.map((g) => (
            <button
              key={g.teamId}
              type="button"
              onClick={() => onOpenTeam(g.teamId)}
              className="flex items-center gap-2 border-b border-subtle px-3 py-2.5 text-left hover:bg-layer-2-hover"
            >
              <TeamAvatar name={g.teamName} />
              <span className="flex min-w-0 flex-grow flex-col gap-0.5">
                <span className="flex w-full items-center gap-1.5 truncate text-body-xs-medium">
                  {g.teamName}
                  {g.unread > 0 && (
                    <span className="ml-auto flex size-4 shrink-0 items-center justify-center rounded-full bg-danger-primary text-[10px] font-medium text-on-current">
                      {g.unread}
                    </span>
                  )}
                </span>
                <span className="truncate text-caption-sm-regular text-tertiary">
                  {g.latestPreview || t("agent_teams_chat_team_session_count", { count: g.sessions.length })}
                </span>
              </span>
            </button>
          ))
        )}
      </div>
    </aside>
  );
}

export function ConversationSidebar({
  sessions,
  activeId,
  loading,
  onBack,
  onSelect,
}: {
  /** 该团队的会话（过滤在父级完成） */
  sessions: ChatSession[];
  activeId: string;
  loading: boolean;
  onBack: () => void;
  onSelect: (sessionId: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <aside className="w-full max-w-60 shrink-0 border-r border-subtle">
      {/* 返回团队列表（二级导航头部） */}
      <button
        type="button"
        onClick={onBack}
        className="flex w-full items-center gap-1.5 px-0 py-2 text-caption-sm-medium text-accent-primary hover:text-accent-hover"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        {t("agent_teams_chat_back_to_teams")}
      </button>
      {loading && sessions.length === 0 ? (
        <div className="p-4 text-body-sm-regular text-tertiary">{t("agent_teams_inbox_loading")}</div>
      ) : sessions.length === 0 ? (
        <div className="px-4 py-8 text-center text-caption-sm-regular text-tertiary">
          {t("agent_teams_chat_empty")}
        </div>
      ) : (
        <div className="flex flex-col">
          {sessions.map((session) => {
            const selected = session.id === activeId;
            return (
              <div
                key={session.id}
                className={`border-l-2 ${selected ? "border-l-accent-primary" : "border-l-transparent"}`}
              >
                <button
                  type="button"
                  onClick={() => onSelect(session.id)}
                  className={`flex w-full items-start gap-2 border-b border-subtle px-3 py-2.5 text-left ${
                    selected ? "bg-layer-3 hover:bg-layer-3" : "hover:bg-layer-2-hover"
                  }`}
                >
                  <span className="relative mt-0.5 shrink-0">
                    {session.member && <MemberAvatar member={session.member} />}
                    {session.unread && (
                      <span
                        className="border-layer-1 absolute -top-1 -right-1 size-2.5 rounded-full border bg-danger-primary"
                        aria-label="unread"
                      />
                    )}
                  </span>
                  <span className="flex min-w-0 flex-grow flex-col gap-0.5">
                    <span className="truncate text-body-xs-medium">{session.title}</span>
                    <span className="truncate text-caption-sm-regular text-tertiary">
                      {/* 预览与会话页同源（displayErrorDetail）：错误轮次 text 为空，
                          共用同一套文案规则，改一处两边同步变 */}
                      {session.lastMessageError
                        ? displayErrorDetail(session.lastMessageError.code as AgentErrorCode, session.lastMessageError.detail) || session.teamName
                        : session.lastMessagePreview || session.teamName}
                    </span>
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </aside>
  );
}
