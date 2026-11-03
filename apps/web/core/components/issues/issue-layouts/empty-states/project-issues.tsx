/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { useParams } from "next/navigation";
// plane imports
import { EUserPermissionsLevel } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { EmptyStateDetailed } from "@plane/propel/empty-state";
import { EIssuesStoreType, EUserProjectRoles } from "@plane/types";
// hooks
import { useCommandPalette } from "@/hooks/store/use-command-palette";
// Agent Teams extension：未绑定项目空态给绑定 CTA（编排域闸门配套）
import { useProjectRuntimeOverview } from "@/services/agent-teams/runtime-swr";
import { WorkflowSwitchModal } from "@/components/agent-teams/workflow-switch-modal";
import { TeamBindModal } from "@/components/agent-teams/team-bind-modal";
import { useUserPermissions } from "@/hooks/store/user";
import { useWorkItemFilterInstance } from "@/hooks/store/work-item-filters/use-work-item-filter-instance";
import { useState } from "react";

export const ProjectEmptyState = observer(function ProjectEmptyState() {
  // router
  const { projectId: routerProjectId } = useParams();
  const projectId = routerProjectId ? routerProjectId.toString() : undefined;
  // plane imports
  const { t } = useTranslation();
  // store hooks
  const { toggleCreateIssueModal } = useCommandPalette();
  const { allowPermissions } = useUserPermissions();
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>();
  const { data: runtimeOverview } = useProjectRuntimeOverview(workspaceSlug, projectId ?? "");
  // 成员收敛 §3.2：未绑定 或 已绑定未挂流程，建卡都会被 PROJECT_NOT_BOUND 拒——
  // 空态按绑定态分叉给「绑定团队」/「配置流程」CTA
  const binding = runtimeOverview?.binding ?? null;
  const isBound = !!binding?.workflowVersionId;
  const [bindOpen, setBindOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  // derived values
  const projectWorkItemFilter = useWorkItemFilterInstance(EIssuesStoreType.PROJECT, projectId);

  const canPerformEmptyStateActions = allowPermissions(
    [EUserProjectRoles.ADMIN, EUserProjectRoles.MEMBER],
    EUserPermissionsLevel.PROJECT
  );

  return (
    <div className="relative h-full w-full overflow-y-auto">
      {projectWorkItemFilter?.hasActiveFilters ? (
        <EmptyStateDetailed
          assetKey="search"
          title={t("common_empty_state.search.title")}
          description={t("common_empty_state.search.description")}
          actions={[
            {
              label: t("project_issues.empty_state.issues_empty_filter.secondary_button.text"),
              onClick: projectWorkItemFilter?.clearFilters,
              disabled: !canPerformEmptyStateActions || !projectWorkItemFilter,
              variant: "secondary",
            },
          ]}
        />
      ) : (
        <EmptyStateDetailed
          assetKey={isBound ? "work-item" : "teamspace"}
          title={t(isBound ? "project_empty_state.work_items.title" : "agent_teams_project_unbound_title")}
          description={t(isBound ? "project_empty_state.work_items.description" : "agent_teams_project_unbound_hint")}
          actions={[
            isBound
              ? {
                  label: t("project_empty_state.work_items.cta_primary"),
                  onClick: () => {
                    toggleCreateIssueModal(true, EIssuesStoreType.PROJECT);
                  },
                  disabled: !canPerformEmptyStateActions,
                  variant: "primary" as const,
                }
              : binding
                ? {
                    // 已绑团队未挂流程：配置流程后才能建卡（两步绑定第二步）
                    label: t("agent_teams_wf_setup"),
                    onClick: () => setSetupOpen(true),
                    disabled: !canPerformEmptyStateActions,
                    variant: "primary" as const,
                  }
                : {
                    // 未绑定：先绑定团队，工作项才能被执行（编排域闸门）
                    label: t("agent_teams_bind_team_short"),
                    onClick: () => setBindOpen(true),
                    disabled: !canPerformEmptyStateActions,
                    variant: "primary" as const,
                  },
          ]}
        />
      )}
      {workspaceSlug && projectId ? (
        <TeamBindModal
          isOpen={bindOpen}
          handleClose={() => setBindOpen(false)}
          workspaceSlug={workspaceSlug}
          projectId={projectId}
          onBound={() => setBindOpen(false)}
        />
      ) : null}
      {workspaceSlug && projectId ? (
        <WorkflowSwitchModal
          isOpen={setupOpen}
          handleClose={() => setSetupOpen(false)}
          workspaceSlug={workspaceSlug}
          projectId={projectId}
          currentWorkflowVersionId={null}
          onSwitched={() => setSetupOpen(false)}
        />
      ) : null}
    </div>
  );
});
