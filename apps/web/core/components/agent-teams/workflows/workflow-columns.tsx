/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * Agent Teams extension — 流程库表格列定义（对齐 Plane 列表 Table 形态，
 * 参照 workspace/settings/useMemberColumns 的列驱动范式）。
 */
import { useTranslation } from "@plane/i18n";
import { GitBranch, History, MoreHorizontal, Pencil, Rocket, Trash2 } from "lucide-react";
import Link from "next/link";
import { CustomMenu } from "@plane/ui";
import type { TTableColumn } from "@plane/ui";
import { WorkflowStatus } from "./workflow-status";
import type { TeamWorkflow } from "@/services/agent-teams/workflow.service";

type Params = {
  canvasPath: (workflowId: string) => string;
  publishingId: string;
  busy: boolean;
  onOpenHistory: (workflow: TeamWorkflow) => void;
  onOpenEdit: (workflow: TeamWorkflow) => void;
  onPublish: (workflow: TeamWorkflow) => void;
  onDelete: (workflow: TeamWorkflow) => void;
};

export function useWorkflowColumns({
  canvasPath,
  publishingId,
  busy,
  onOpenHistory,
  onOpenEdit,
  onPublish,
  onDelete,
}: Params): TTableColumn<TeamWorkflow>[] {
  const { t } = useTranslation();
  return [
    {
      key: "name",
      content: t("agent_teams_workflows_col_name"),
      tdRender: (workflow) => (
        <Link href={canvasPath(workflow.id)} className="text-primary hover:text-accent-primary hover:underline">
          {workflow.name}
        </Link>
      ),
    },
    {
      key: "status",
      content: t("agent_teams_wf_col_status"),
      tdRender: (workflow) => <WorkflowStatus status={workflow.status} />,
    },
    {
      key: "version",
      content: t("agent_teams_wf_col_version"),
      tdRender: (workflow) => (workflow.currentVersion != null ? `v${workflow.currentVersion}` : "—"),
    },
    {
      key: "updated",
      content: t("agent_teams_wf_col_published_at"),
      tdRender: (workflow) => (workflow.updatedAt ? new Date(workflow.updatedAt).toLocaleDateString() : "—"),
    },
    {
      key: "actions",
      content: "",
      tdRender: (workflow) => (
        <div className="flex items-center justify-end gap-1">
          {publishingId === workflow.id ? (
            <span className="text-11 text-accent-primary">{t("agent_teams_workflows_publishing")}</span>
          ) : null}
          <CustomMenu
            customButton={<MoreHorizontal className="size-4 text-tertiary hover:text-primary" aria-hidden />}
            placement="bottom-end"
            closeOnSelect
          >
            <CustomMenu.MenuItem
              onClick={() => window.open(canvasPath(workflow.id), "_self")}
              className="flex items-center gap-2"
            >
              <GitBranch className="size-3.5" aria-hidden />
              {t("agent_teams_workflows_open_canvas")}
            </CustomMenu.MenuItem>
            <CustomMenu.MenuItem onClick={() => onOpenHistory(workflow)} className="flex items-center gap-2">
              <History className="size-3.5" aria-hidden />
              {t("agent_teams_workflows_history")}
            </CustomMenu.MenuItem>
            <CustomMenu.MenuItem onClick={() => onOpenEdit(workflow)} className="flex items-center gap-2">
              <Pencil className="size-3.5" aria-hidden />
              {t("agent_teams_workflows_edit")}
            </CustomMenu.MenuItem>
            <CustomMenu.MenuItem
              onClick={() => onPublish(workflow)}
              disabled={busy}
              className="flex items-center gap-2"
            >
              <Rocket className="size-3.5" aria-hidden />
              {t("agent_teams_workflows_publish")}
            </CustomMenu.MenuItem>
            <CustomMenu.MenuItem onClick={() => onDelete(workflow)} className="text-red-500 flex items-center gap-2">
              <Trash2 className="size-3.5" aria-hidden />
              {t("agent_teams_workflows_delete")}
            </CustomMenu.MenuItem>
          </CustomMenu>
        </div>
      ),
    },
  ];
}
