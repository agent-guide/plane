/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * Agent Teams extension — 团队成员管理页（侧边栏子项落点，全功能）。
 * 列表复用 @plane/ui 的 Table；成员头像拆到 member-avatar 组件。原团队
 * 详情「成员」区块退役后，聊天入口/profile 跳转/capabilities/role 徽章/
 * 类型点全部迁移到此处。
 */
import { useEffect, useState } from "react";
import { observer } from "mobx-react";
import { useParams } from "react-router";
import Link from "next/link";
import { useTranslation } from "@plane/i18n";
import { Bot, MessageSquare, Power, User, UserMinus } from "lucide-react";
import { Button as PropelButton } from "@plane/propel/button";
import { EmptyStateDetailed } from "@plane/propel/empty-state";
import { Breadcrumbs, ContentWrapper, Header, Table } from "@plane/ui";
import type { TTableColumn } from "@plane/ui";
// components
import { AppHeader } from "@/components/core/app-header";
import { PageHead } from "@/components/core/page-title";
import { BreadcrumbLink } from "@/components/common/breadcrumb-link";
import { useAgentTeamsLinks } from "@/components/agent-teams/helper";
import { AddMemberModal } from "@/components/agent-teams/team-manage-modals";
import { MemberAvatar } from "@/components/agent-teams/member-avatar";
// services
import { setExpertsWorkspaceSlug } from "@/services/agent-teams/experts-auth";
import runtimeService, { type AgentTeam, type AgentTeamMember } from "@/services/agent-teams/runtime.service";
import { classifyRuntimeFailure, type RuntimeFailureKind } from "@/services/agent-teams/runtime-errors";
// hooks
import { useWorkspace } from "@/hooks/store/use-workspace";

const MemberListPage = observer(function MemberListPage() {
  const { t } = useTranslation();
  const { workspaceSlug: wsSlugParam, teamId } = useParams<{ workspaceSlug: string; teamId: string }>();
  const workspaceSlug = wsSlugParam ?? "";
  const { currentWorkspace } = useWorkspace();
  const { memberChatPath } = useAgentTeamsLinks();

  const [team, setTeam] = useState<AgentTeam | null>(null);
  const [members, setMembers] = useState<AgentTeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  // 失败原因分类：工作区没接入时重试永远不会成功，不能再给「重试」按钮。
  const [failure, setFailure] = useState<RuntimeFailureKind | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const canManage = team?.viewerCanManage === true && team.status !== "archived";

  const load = () => {
    if (!teamId) return;
    setExpertsWorkspaceSlug(workspaceSlug);
    Promise.all([runtimeService.getTeam(teamId), runtimeService.listTeamMembers(teamId)])
      .then(([teamInfo, memberItems]) => {
        setTeam(teamInfo);
        setMembers(memberItems);
        setFailure(null);
        return null;
      })
      .catch((error) => setFailure(classifyRuntimeFailure(error)))
      .finally(() => setLoading(false));
  };

  useEffect(load, [teamId, workspaceSlug]); // eslint-disable-line react-hooks/exhaustive-deps

  const runAction = (action: () => Promise<unknown>) => {
    setBusy(true);
    action()
      .then(load)
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };

  const pageTitle = currentWorkspace?.name ? `${currentWorkspace?.name} - Team Members` : undefined;

  const columns: TTableColumn<AgentTeamMember>[] = [
    {
      key: "member",
      content: t("agent_teams_members_title"),
      tdRender: (member) => (
        <div className="flex items-center gap-3">
          <MemberAvatar member={member} />
          {member.planeUserId ? (
            <Link
              href={`/${workspaceSlug}/profile/${member.planeUserId}`}
              className="text-primary hover:text-accent-primary hover:underline"
            >
              {member.displayName}
            </Link>
          ) : (
            <span className="text-primary">{member.displayName}</span>
          )}
        </div>
      ),
    },
    {
      key: "kind",
      content: t("agent_teams_member_kind"),
      tdRender: (member) => (
        <span className="flex items-center gap-1.5 text-secondary">
          {member.kind === "agent" ? (
            <Bot className="size-3.5 text-tertiary" aria-hidden />
          ) : (
            <User className="size-3.5 text-tertiary" aria-hidden />
          )}
          {member.kind === "agent" ? t("agent_teams_kind_agent") : t("agent_teams_kind_human")}
        </span>
      ),
    },
    {
      key: "role",
      content: t("agent_teams_member_role_label"),
      tdRender: (member) => (
        <span className="rounded-full bg-layer-3 px-2 py-0.5 text-caption-sm-regular text-secondary">
          {member.role}
        </span>
      ),
    },
    {
      key: "capabilities",
      content: t("agent_teams_capabilities"),
      tdRender: (member) =>
        member.capabilities && member.capabilities.length > 0 ? (
          <span className="block max-w-60 truncate text-tertiary">{member.capabilities.join(" · ")}</span>
        ) : (
          <span className="text-tertiary">—</span>
        ),
    },
    {
      key: "status",
      content: t("agent_teams_member_status"),
      tdRender: (member) => (
        <span className={`text-11 ${member.enabled === false ? "text-tertiary" : "text-accent-primary"}`}>
          {member.enabled === false ? t("agent_teams_member_disable") : t("agent_teams_member_enable")}
        </span>
      ),
    },
    {
      key: "actions",
      content: "",
      tdRender: (member) => (
        <div className="flex items-center justify-end gap-1">
          {member.kind === "agent" && member.expertId ? (
            <Link
              href={memberChatPath(member.expertId, member.displayName)}
              className="flex items-center rounded p-1 text-secondary hover:bg-layer-2-hover hover:text-accent-primary"
              title={t("agent_teams_chat_with", { name: member.displayName })}
            >
              <MessageSquare className="size-3.5" aria-hidden />
            </Link>
          ) : null}
          {canManage ? (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  runAction(() =>
                    runtimeService.updateTeamMember(teamId, member.id, { enabled: member.enabled === false })
                  )
                }
                className="rounded p-1 text-secondary hover:bg-layer-2-hover hover:text-accent-primary disabled:opacity-50"
                title={member.enabled === false ? t("agent_teams_member_enable") : t("agent_teams_member_disable")}
              >
                <Power className="size-3.5" aria-hidden />
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(t("agent_teams_member_remove_confirm", { name: member.displayName }))) {
                    runAction(() => runtimeService.removeTeamMember(teamId, member.id));
                  }
                }}
                className="rounded p-1 text-secondary hover:bg-layer-2-hover hover:text-danger-primary disabled:opacity-50"
                title={t("agent_teams_member_remove")}
              >
                <UserMinus className="size-3.5" aria-hidden />
              </button>
            </>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHead title={pageTitle} />
      <div className="flex h-full w-full flex-col overflow-hidden">
        <AppHeader
          header={
            <Header>
              <Header.LeftItem>
                <Breadcrumbs>
                  <Breadcrumbs.Item
                    component={
                      <BreadcrumbLink label={team?.name ?? teamId} href={`/${workspaceSlug}/agent-teams/${teamId}`} />
                    }
                  />
                  <Breadcrumbs.Item
                    component={<BreadcrumbLink label={t("agent_teams_members_title")} disableTooltip />}
                  />
                </Breadcrumbs>
              </Header.LeftItem>
              <Header.RightItem>
                {canManage ? (
                  <PropelButton variant="primary" size="lg" onClick={() => setAddOpen(true)}>
                    {t("agent_teams_add_member_title")}
                  </PropelButton>
                ) : null}
              </Header.RightItem>
            </Header>
          }
        />
        <ContentWrapper>
          {/* flex-1：整页空态要占满剩余高度才能垂直居中（同 Plane 整页列表）。 */}
          <div className="flex min-h-0 w-full flex-1 flex-col gap-4 pb-10">
            {loading ? (
              <div className="rounded-lg border border-subtle px-4 py-10 text-center text-13 text-tertiary">
                {t("agent_teams_inbox_loading")}
              </div>
            ) : failure || !team ? (
              // 未接入的工作区重试永远不成功——只给说明与指引，不给重试按钮。
              failure === "not_connected" ? (
                <EmptyStateDetailed
                  assetKey="invalid-link"
                  assetClassName="size-40"
                  title={t("agent_teams_runtime_not_connected_title")}
                  description={t("agent_teams_runtime_not_connected_hint")}
                />
              ) : (
                <EmptyStateDetailed
                  assetKey="server-error"
                  assetClassName="size-40"
                  title={t(
                    failure === "unavailable" ? "agent_teams_runtime_unavailable_title" : "agent_teams_load_failed"
                  )}
                  description={failure === "unavailable" ? t("agent_teams_runtime_unavailable_hint") : undefined}
                  actions={[{ label: t("agent_teams_project_retry"), variant: "secondary", onClick: load }]}
                />
              )
            ) : members.length === 0 ? (
              // 空态不放「添加成员」按钮：与右上角主操作重复。整页用详细空态
              // （竖版插图），与工作项、周期等整页列表同一套视觉。
              <EmptyStateDetailed
                assetKey="teamspace"
                assetClassName="size-40"
                title={t("agent_teams_members_empty_title")}
                description={t("agent_teams_members_empty_manage")}
              />
            ) : (
              <div className="overflow-x-auto">
                <Table
                  data={members}
                  columns={columns}
                  keyExtractor={(member) => member.id}
                  tHeadClassName="border-b border-subtle"
                  tHeadTrClassName="divide-x-0"
                  thClassName="text-left font-medium text-placeholder"
                  tBodyTrClassName="divide-x-0"
                />
              </div>
            )}
          </div>
        </ContentWrapper>
      </div>

      {teamId ? (
        <AddMemberModal isOpen={addOpen} handleClose={() => setAddOpen(false)} teamId={teamId} onAdded={load} />
      ) : null}
    </>
  );
});

export default MemberListPage;
