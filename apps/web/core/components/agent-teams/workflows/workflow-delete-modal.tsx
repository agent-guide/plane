/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * Agent Teams extension — 流程删除确认（从 team-workflows-section 拆出）。
 * AlertModalCore（Plane 标准确认弹层，cycles/delete-modal 同款）。
 */
import { useTranslation } from "@plane/i18n";
import { AlertModalCore } from "@plane/ui";
import type { TeamWorkflow } from "@/services/agent-teams/workflow.service";

type Props = {
  workflow: TeamWorkflow | null;
  deleting: boolean;
  onClose: () => void;
  onConfirm: () => void;
};

export function WorkflowDeleteModal({ workflow, deleting, onClose, onConfirm }: Props) {
  const { t } = useTranslation();
  return (
    <AlertModalCore
      handleClose={onClose}
      handleSubmit={onConfirm}
      isSubmitting={deleting}
      isOpen={!!workflow}
      title={t("agent_teams_workflows_delete")}
      primaryButtonText={{
        loading: t("agent_teams_workflows_deleting"),
        default: t("agent_teams_workflows_delete"),
      }}
      secondaryButtonText={t("cancel")}
      content={
        <>
          {t("agent_teams_workflows_delete_confirm_prefix")}
          {' "'}
          <span className="font-medium break-words text-primary">{workflow?.name}</span>
          {'"'}
          {t("agent_teams_workflows_delete_confirm_suffix")}
        </>
      }
    />
  );
}
