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
            {projectId ? <ProjectWorkflowsManager ref={managerRef} projectId={projectId} /> : null}
          </div>
        </ContentWrapper>
      </div>
    </>
  );
});

export default ProjectWorkflowsPage;
