/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file in the repository root for more details.
 *
 * 数字员工会话页（P2 一期）——薄壳：路由参数、会话列表装载与选中态机、
 * 侧栏与面包屑。会话内的一切（消息流/流式/发送/确认卡/贴回卡片）在
 * ConversationPane——以 key={会话id} 挂载，切换会话即销毁重建实例，
 * 状态隔离是结构保证（2026-11-19 重构：曾为页面级单例 state 泄漏所困）。
 *
 * 两级导航（微信折叠群聊同构）：?team= 二级上下文；一级不选中任何会话。
 * 深链：?member=&expert=&team=&name=（成员行「发起对话」）。
 */
import { useCallback, useEffect, useState } from "react";
import { observer } from "mobx-react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { useTranslation } from "@plane/i18n";
import { Breadcrumbs, ContentWrapper, Header } from "@/core/ui-compat";
import { MessageSquare, Users } from "lucide-react";

import { AppHeader } from "@/components/core/app-header";
import { PageHead } from "@/components/core/page-title";
import { BreadcrumbLink } from "@/components/common/breadcrumb-link";
import { useAgentTeamsLinks } from "@/components/agent-teams/helper";
import { ConversationPane } from "@/components/agent-teams/chat/conversation-pane";
import { ConversationSidebar, TeamSidebar } from "@/components/agent-teams/chat/sidebars";
import { deriveActiveSession, type ChatDeepLink, type ChatSession } from "@/components/agent-teams/chat/types";
import chatService from "@/services/agent-teams/chat.service";
import { useWorkspace } from "@/hooks/store/use-workspace";

function AgentTeamsChatPage() {
  const { t } = useTranslation();
  const { currentWorkspace } = useWorkspace();
  const { agentTeamsPath } = useAgentTeamsLinks();
  const navigate = useNavigate();
  const { workspaceSlug: slugParam } = useParams<{ workspaceSlug: string }>();
  const workspaceSlug = slugParam ?? "";
  const [searchParams] = useSearchParams();
  const link: ChatDeepLink = {
    member: searchParams.get("member") ?? undefined,
    expert: searchParams.get("expert") ?? undefined,
    team: searchParams.get("team") ?? undefined,
    name: searchParams.get("name") ?? undefined,
  };
  const inTeamView = Boolean(link.team);

  const pageTitle = currentWorkspace?.name ? `${currentWorkspace?.name} - ${t("agent_teams_chat_title")}` : undefined;

  // ── 会话列表 + 选中态（页面级；会话内状态在 ConversationPane 实例） ──
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeId, setActiveId] = useState("");
  const [loading, setLoading] = useState(true);

  // 一级（团队层）不显示会话内容——选中会话仅存在于二级（两级导航不变量）
  const active = inTeamView ? sessions.find((s) => s.id === activeId) : undefined;
  const teamSessions = link.team ? sessions.filter((s) => s.teamId === link.team) : [];
  const teamName = active?.teamName ?? teamSessions[0]?.teamName;

  // ── 会话装载 + 深链选中态机 ──────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const list = await chatService.listSessions(workspaceSlug);
        if (cancelled) return;
        setSessions(list);
        const { nextActiveId, sessionToCreate } = deriveActiveSession(list, link, activeId);
        if (sessionToCreate) {
          const created = await chatService.createSession(workspaceSlug, sessionToCreate);
          if (cancelled) return;
          setSessions((prev) => [created, ...prev]);
          setActiveId(created.id);
        } else {
          setActiveId(nextActiveId);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // link 各字段来自 searchParams；activeId 经 deriveActiveSession 语义化读取
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceSlug, link.member, link.expert, link.team, link.name]);

  // 会话内变化（已读/新消息预览）→ 重拉列表（活跃会话未读恒清）
  const refreshSessions = useCallback(() => {
    void chatService.listSessions(workspaceSlug).then((fresh) => {
      setSessions((prev) =>
        prev.map((s) => {
          const hit = fresh.find((n) => n.id === s.id);
          return hit ? (s.id === activeId ? { ...hit, unread: false } : hit) : s;
        })
      );
      return null;
    });
  }, [workspaceSlug, activeId]);

  return (
    <>
      <PageHead title={pageTitle} />
      <div className="flex h-full w-full flex-col overflow-hidden">
        <AppHeader
          header={
            <Header>
              <Header.LeftItem>
                <Breadcrumbs>
                  {!inTeamView && (
                    <Breadcrumbs.Item
                      component={
                        <BreadcrumbLink
                          label={t("agent_teams_breadcrumb")}
                          href={agentTeamsPath}
                          icon={<Users className="size-4 text-tertiary" />}
                        />
                      }
                    />
                  )}
                  {inTeamView && (
                    <Breadcrumbs.Item
                      component={
                        <BreadcrumbLink
                          label={teamName ?? ""}
                          href={`/${workspaceSlug}/agent-teams/${link.team}`}
                          icon={<Users className="size-4 text-tertiary" />}
                        />
                      }
                    />
                  )}
                  <Breadcrumbs.Item
                    component={
                      <BreadcrumbLink
                        label={t("agent_teams_chat_title")}
                        icon={<MessageSquare className="size-4 text-tertiary" />}
                      />
                    }
                  />
                </Breadcrumbs>
              </Header.LeftItem>

            </Header>
          }
        />
        <ContentWrapper>
          <div className="flex h-full w-full overflow-hidden">
            {inTeamView ? (
              <ConversationSidebar
                sessions={teamSessions}
                activeId={activeId}
                loading={loading}
                onBack={() => {
                  setActiveId("");
                  navigate(`/${workspaceSlug}/agent-teams/chat`);
                }}
                onSelect={setActiveId}
              />
            ) : (
              <TeamSidebar
                sessions={sessions}
                loading={loading}
                onOpenTeam={(teamId) => navigate(`/${workspaceSlug}/agent-teams/chat?team=${teamId}`)}
              />
            )}

            {/* 会话面板：key 保证切换即换实例，会话状态互不渗透 */}
            {active ? (
              <ConversationPane
                key={active.id}
                workspaceSlug={workspaceSlug}
                session={active}
                onSessionsRefresh={refreshSessions}
                onOpenCard={(projectId, issueId) =>
                  navigate(`/${workspaceSlug}/projects/${projectId}/issues/${issueId}`)
                }
              />
            ) : (
              <div className="flex h-full min-w-0 flex-grow flex-col">
                <div className="m-auto text-body-sm-regular text-tertiary">
                  {t(inTeamView ? "agent_teams_chat_no_session" : "agent_teams_chat_pick_team")}
                </div>
              </div>
            )}
          </div>
        </ContentWrapper>
      </div>
    </>
  );
}

export default observer(AgentTeamsChatPage);
