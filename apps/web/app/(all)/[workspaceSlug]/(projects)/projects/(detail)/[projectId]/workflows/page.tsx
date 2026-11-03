/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Agent Teams extension — 项目流程库页（流程归项目所有、团队负责执行：
 * 2026-10-29 方案 A，自团队路由 /agent-teams/[teamId]/processes 迁移）。
 * 编排/发布/元数据编辑/版本历史都在本页完成；行与弹层拆分见 workflows/ 目录。
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
import { ProjectWorkflowsManager, type WorkflowsManagerHandle } from "@/components/agent-teams/workflows/manager";
import { TeamBindModal } from "@/components/agent-teams/team-bind-modal";
import { EmptyStateDetailed } from "@plane/propel/empty-state";
// services
import { orchestrationService } from "@/services/agent-teams/orchestration.service";
// hooks
import { useProject } from "@/hooks/store/use-project";

const ProjectWorkflowsPage = observer(function ProjectWorkflowsPage() {
  const { t } = useTranslation();
  const { workspaceSlug: wsSlugParam, projectId } = useParams<{ workspaceSlug: string; projectId: string }>();
  const workspaceSlug = wsSlugParam ?? "";
  const { currentProjectDetails: project } = useProject();
  const managerRef = useRef<WorkflowsManagerHandle>(null);

  const [projectName, setProjectName] = useState<string | null>(null);
  useEffect(() => {
    if (project?.name) setProjectName(project.name);
  }, [project?.name]);

  // 建流程闸门（成员收敛 §3.2）：未绑定团队的项目不能建流程——
  // 整页换「先绑定团队」空态 + 绑定弹层（后端 409 PROJECT_NOT_BOUND 同源拦截）。
  const [bound, setBound] = useState<boolean | null>(null); // null = 判定中
  const [bindOpen, setBindOpen] = useState(false);
  useEffect(() => {
    if (!workspaceSlug || !projectId) return;
    let ignore = false;
    orchestrationService
      .listBindings(workspaceSlug, projectId)
      .then((bindings) => {
        if (!ignore) setBound(bindings.some((b) => b.status === "active"));
        return null;
      })
      .catch(() => {
        if (!ignore) setBound(true); // 判定失败不拦页面（后端创建时仍会拦）
      });
    return () => {
      ignore = true;
    };
  }, [workspaceSlug, projectId]);

  const pageTitle = project?.name ? `${project.name} - ${t("agent_teams_workflows_title")}` : undefined;

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
                      <BreadcrumbLink
                        label={projectName ?? projectId ?? ""}
                        href={`/${workspaceSlug}/projects/${projectId}`}
                      />
                    }
                  />
                  <Breadcrumbs.Item
                    component={<BreadcrumbLink label={t("agent_teams_workflows_title")} disableTooltip />}
                  />
                </Breadcrumbs>
              </Header.LeftItem>
              <Header.RightItem>
                {bound ? (
                  <PropelButton variant="primary" size="lg" onClick={() => managerRef.current?.openCreate()}>
                    {t("agent_teams_workflows_create")}
                  </PropelButton>
                ) : null}
              </Header.RightItem>
            </Header>
          }
        />
        <ContentWrapper>
          {/* flex-1：整页空态要占满剩余高度才能垂直居中（同 Plane 整页列表）。 */}
          <div className="flex min-h-0 w-full flex-1 flex-col gap-4 pb-10">
            {projectId && bound === false ? (
              <div className="flex min-h-0 flex-1 items-center justify-center">
                <EmptyStateDetailed
                  assetKey="module"
                  assetClassName="size-40"
                  title={t("agent_teams_workflows_need_bind_title")}
                  description={t("agent_teams_workflows_need_bind_hint")}
                  actions={[
                    {
                      label: t("agent_teams_workflows_need_bind_cta"),
                      variant: "primary",
                      onClick: () => setBindOpen(true),
                    },
                  ]}
                />
              </div>
            ) : projectId ? (
              <ProjectWorkflowsManager ref={managerRef} projectId={projectId} />
            ) : null}
          </div>
        </ContentWrapper>
        <TeamBindModal
          isOpen={bindOpen}
          handleClose={() => setBindOpen(false)}
          workspaceSlug={workspaceSlug}
          projectId={projectId ?? ""}
          onBound={() => setBound(true)}
        />
      </div>
    </>
  );
});

export default ProjectWorkflowsPage;
