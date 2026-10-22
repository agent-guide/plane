/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * Agent Teams extension — 流程状态点（从 team-workflows-section 拆出）。
 * 四态映射：发布中/失败此前被硬编码折叠进"草稿"，本地发布实际进行约 7
 * 分钟期间版本历史全程误显"草稿"（10-20 实证修复）。
 */
import { useTranslation } from "@plane/i18n";

const WORKFLOW_STATUS_LABEL: Record<string, string> = {
  draft: "agent_teams_workflows_status_draft",
  publishing: "agent_teams_workflows_status_publishing",
  published: "agent_teams_workflows_status_published",
  failed: "agent_teams_workflows_status_failed",
};
const WORKFLOW_STATUS_TONE: Record<string, string> = {
  published: "text-accent-primary",
  publishing: "text-accent-primary",
  failed: "text-danger-primary",
};

export function WorkflowStatus({ status }: { status: string }) {
  const { t } = useTranslation();
  const labelKey = WORKFLOW_STATUS_LABEL[status] ?? WORKFLOW_STATUS_LABEL.draft;
  const tone = WORKFLOW_STATUS_TONE[status] ?? "text-tertiary";
  return (
    <span className={`inline-flex flex-shrink-0 items-center gap-1 text-caption-sm-regular ${tone}`}>
      <span
        className={`size-1.5 rounded-full ${
          status === "publishing"
            ? "animate-pulse bg-accent-primary"
            : status === "published"
              ? "bg-accent-primary"
              : status === "failed"
                ? "bg-danger-primary"
                : "bg-tertiary"
        }`}
        aria-hidden
      />
      {t(labelKey)}
    </span>
  );
}
