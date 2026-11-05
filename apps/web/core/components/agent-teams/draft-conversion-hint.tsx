/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Agent Teams extension — 草稿转正执行归属提示（#9）：转正弹层按所选项目
 * 展示「将由 xx 团队自动执行」（已配流程）/「该项目尚未配置团队流程，
 * 转正后为普通工作卡」（已绑团队未配流程；此时后端闸门 409 会拦下转正）。
 */
import useSWR from "swr";
import { useTranslation } from "@plane/i18n";
import { Bot } from "lucide-react";
import { orchestrationService } from "@/services/agent-teams/orchestration.service";

export function DraftConversionHint({
  workspaceSlug,
  projectId,
}: {
  workspaceSlug?: string;
  projectId?: string | null;
}) {
  const { t } = useTranslation();
  const { data: overview } = useSWR(
    workspaceSlug && projectId ? (["orchestration", "runtime-overview", workspaceSlug, projectId] as const) : null,
    () => orchestrationService.getProjectRuntimeOverview(workspaceSlug!, projectId!),
    { revalidateOnFocus: false, shouldRetryOnError: false }
  );
  const binding = overview?.binding ?? null;
  if (!binding) return null;
  if (binding.workflowVersion == null) {
    return (
      <p className="mt-1.5 flex items-center gap-1.5 rounded bg-layer-2 px-2.5 py-1.5 text-caption-sm-regular text-secondary">
        <Bot className="size-3.5 flex-shrink-0 text-tertiary" aria-hidden />
        {t("agent_teams_draft_convert_no_workflow")}
      </p>
    );
  }
  return (
    <p className="mt-1.5 flex items-center gap-1.5 rounded bg-layer-2 px-2.5 py-1.5 text-caption-sm-regular text-secondary">
      <Bot className="size-3.5 flex-shrink-0 text-accent-primary" aria-hidden />
      {t("agent_teams_draft_convert_auto_exec", { team: binding.teamName })}
    </p>
  );
}
