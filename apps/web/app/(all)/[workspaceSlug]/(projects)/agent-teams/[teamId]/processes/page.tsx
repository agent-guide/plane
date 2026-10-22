/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * Agent Teams extension — 团队流程管理页（侧边栏子项落点，全功能）。
 * 编排/发布/元数据编辑/版本历史都在本页完成（原团队详情流程区块退役后，
 * 迁移到此处）。行与弹层拆分见 workflows/ 目录。
 */
import { useEffect, useRef, useState } from "react";
import { observer } from "mobx-react";
import { useParams } from "react-router";
import { useTranslation } from "@plane/i18n";
import { Button as PropelButton } from "@plane/propel/button";
import { Breadcrumbs, ContentWrapper, Header } from "@plane/ui";
// components
import { AppHeader } from "@/components/core/app-header";
import { PageHead } from "@/components/core/page-title";
import { BreadcrumbLink } from "@/components/common/breadcrumb-link";
import { TeamWorkflowsManager, type TeamWorkflowsManagerHandle } from "@/components/agent-teams/workflows/manager";
// services
import { setExpertsWorkspaceSlug } from "@/services/agent-teams/experts-auth";
import runtimeService, { type AgentTeam } from "@/services/agent-teams/runtime.service";
// hooks
import { useWorkspace } from "@/hooks/store/use-workspace";

const ProcessListPage = observer(function ProcessListPage() {
  const { t } = useTranslation();
  const { workspaceSlug: wsSlugParam, teamId } = useParams<{ workspaceSlug: string; teamId: string }>();
  const workspaceSlug = wsSlugParam ?? "";
  const { currentWorkspace } = useWorkspace();
  const managerRef = useRef<TeamWorkflowsManagerHandle>(null);

  const [team, setTeam] = useState<AgentTeam | null>(null);

  useEffect(() => {
    if (!teamId) return;
    setExpertsWorkspaceSlug(workspaceSlug);
    runtimeService
      .getTeam(teamId)
      .then(setTeam)
      .catch(() => undefined);
  }, [teamId, workspaceSlug]);

  const pageTitle = currentWorkspace?.name ? `${currentWorkspace?.name} - Team Workflows` : undefined;

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
                    component={<BreadcrumbLink label={t("agent_teams_workflows_title")} disableTooltip />}
                  />
                </Breadcrumbs>
              </Header.LeftItem>
              <Header.RightItem>
                <PropelButton variant="primary" size="lg" onClick={() => managerRef.current?.openCreate()}>
                  {t("agent_teams_workflows_create")}
                </PropelButton>
              </Header.RightItem>
            </Header>
          }
        />
        <ContentWrapper>
          {/* flex-1：整页空态要占满剩余高度才能垂直居中（同 Plane 整页列表）。 */}
          <div className="flex min-h-0 w-full flex-1 flex-col gap-4 pb-10">
            <TeamWorkflowsManager ref={managerRef} teamId={teamId} />
          </div>
        </ContentWrapper>
      </div>
    </>
  );
});

export default ProcessListPage;
