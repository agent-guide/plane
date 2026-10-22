/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * Agent Teams extension — 流程版本历史弹层（从 team-workflows-section 拆出）。
 * 列：版本[最新标]/状态[失败⚠]/发布时间/创建人（定义摘要是审计内容指纹，
 * 对用户无消费价值，不展示）。
 */
import { useMemo } from "react";
import { useTranslation } from "@plane/i18n";
import { Button as PropelButton } from "@plane/propel/button";
import { EModalPosition, EModalWidth, ModalCore, Table } from "@plane/ui";
import { format, parseISO } from "date-fns";
import { WorkflowStatus } from "./workflow-status";
import type { TeamWorkflow, TeamWorkflowVersion } from "@/services/agent-teams/workflow.service";

type Props = {
  isOpen: boolean;
  workflow: TeamWorkflow | null;
  versions: TeamWorkflowVersion[];
  loading: boolean;
  onClose: () => void;
};

export function WorkflowHistoryModal({ isOpen, workflow, versions, loading, onClose }: Props) {
  const { t } = useTranslation();

  const columns = useMemo(
    () => [
      {
        key: "version",
        content: t("agent_teams_wf_col_version"),
        tdRender: (row: TeamWorkflowVersion) => (
          <span className="text-13 text-primary">
            v{row.version}
            {versions[0]?.id === row.id ? (
              <span className="ml-2 rounded-full bg-accent-subtle px-2 py-0.5 text-11 text-accent-primary">
                {t("agent_teams_wf_latest")}
              </span>
            ) : null}
          </span>
        ),
      },
      {
        key: "status",
        content: t("agent_teams_wf_col_status"),
        tdRender: (row: TeamWorkflowVersion) => (
          <span>
            <WorkflowStatus status={row.status} />
            {row.publishError ? (
              <span className="ml-1 text-11 text-danger-primary" title={row.publishError}>
                ⚠
              </span>
            ) : null}
          </span>
        ),
      },
      {
        key: "publishedAt",
        content: t("agent_teams_wf_col_published_at"),
        tdRender: (row: TeamWorkflowVersion) => (
          <span className="text-12 text-secondary">
            {/* renderFormattedDate 只取日期串前 10 位（时间恒 00:00），精确到
                分钟必须 date-fns 直接解析完整 ISO（10-13 实证）。 */}
            {row.publishedAt ? format(parseISO(row.publishedAt), "yyyy-MM-dd HH:mm") : "-"}
          </span>
        ),
      },
      {
        key: "createdBy",
        content: t("agent_teams_wf_col_created_by"),
        tdRender: (row: TeamWorkflowVersion) => (
          <span className="text-12 text-secondary">{row.createdByName ?? row.createdBy ?? "-"}</span>
        ),
      },
    ],
    [t, versions]
  );

  return (
    <ModalCore isOpen={isOpen} handleClose={onClose} position={EModalPosition.TOP} width={EModalWidth.XXL}>
      <div className="space-y-4 p-5">
        <h3 className="text-18 font-medium text-secondary">
          {t("agent_teams_workflows_history_title", { name: workflow?.name ?? "" })}
        </h3>
        {loading ? (
          <div className="py-8 text-center text-13 text-tertiary">{t("agent_teams_inbox_loading")}</div>
        ) : versions.length === 0 ? (
          // 弹层里的空态跟上方加载行同款一行灰字：插图在窄弹层里过重。
          <div className="py-8 text-center text-13 text-tertiary">{t("agent_teams_workflows_history_empty")}</div>
        ) : (
          <Table
            columns={columns}
            data={versions}
            keyExtractor={(row) => row.id}
            tHeadClassName="border-b border-subtle"
            thClassName="text-left font-medium divide-x-0 text-placeholder"
            tBodyClassName="divide-y-0"
            tBodyTrClassName="divide-x-0 h-[40px] text-secondary"
            tHeadTrClassName="divide-x-0"
          />
        )}
      </div>
      <div className="flex items-center justify-end border-t-[0.5px] border-subtle px-5 py-4">
        <PropelButton variant="secondary" size="lg" onClick={onClose}>
          {t("close")}
        </PropelButton>
      </div>
    </ModalCore>
  );
}
