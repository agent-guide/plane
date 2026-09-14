/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * Agent Teams extension — the "team approvals" tab body of the native
 * notifications inbox (design §12.6.4): waiting human decisions as summary
 * rows (scope badge / title / project / task ref / age). Clicking a row
 * opens the full decision (question, context, answer actions) in the right
 * pane via the approvals selection context — same master-detail interaction
 * as the native notification cards.
 */
import { observer } from "mobx-react";
// i18n
import { useTranslation } from "@plane/i18n";
// plane imports
import { Row } from "@plane/ui";
import { cn, renderFormattedDate, renderFormattedTime } from "@plane/utils";
// icons
import { Bot } from "lucide-react";
// hooks
import { useProject } from "@/hooks/store/use-project";
// components
import { useAgentApprovalsSelection } from "@/components/agent-teams/approvals-context";
// services
import { usePendingApprovals } from "@/services/agent-teams/runtime-swr";

type TAgentApprovalCardList = {
  workspaceSlug: string;
};

export const AgentApprovalCardList = observer(function AgentApprovalCardList({
  workspaceSlug,
}: TAgentApprovalCardList) {
  const { t } = useTranslation();
  const { getProjectById } = useProject();
  const { items, isLoading } = usePendingApprovals(workspaceSlug);
  const { selected, setSelected } = useAgentApprovalsSelection();

  if (isLoading && items.length === 0) {
    return (
      <div className="px-4 py-8 text-center text-body-sm-regular text-tertiary">
        {t("agent_teams_inbox_loading")}
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="px-4 py-8 text-center text-body-sm-regular text-tertiary">
        {t("agent_teams_approvals_empty")}
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {items.map((item) => {
        const isSelected = selected?.requestId === item.requestId && selected?.scope === item.scope;
        const project = item.externalProjectId ? getProjectById(item.externalProjectId) : undefined;
        return (
          <Row
            key={`${item.scope}:${item.requestId}`}
            className={cn(
              "group relative flex cursor-pointer items-center gap-2 border-b border-subtle py-4 transition-all hover:bg-layer-1/30",
              { "bg-layer-1/30": isSelected }
            )}
            onClick={() => setSelected(item)}
          >
            <div className="relative flex size-8 flex-shrink-0 items-center justify-center rounded-lg border border-subtle bg-layer-2">
              <Bot className="size-4 text-secondary" aria-hidden />
            </div>
            <div className="w-full min-w-0 flex flex-col gap-1">
              <div className="line-clamp-1 truncate overflow-hidden text-body-xs-medium break-all whitespace-normal text-primary">
                {item.title || t("agent_teams_panel_approve_now")}
              </div>
              {project?.name && <div className="line-clamp-1 text-caption-sm-regular text-secondary">{project.name}</div>}
              <div className="flex items-center gap-2 text-caption-sm-regular text-tertiary">
                {item.taskTitle && <span className="line-clamp-1 truncate">{item.taskTitle}</span>}
                <span className="ml-auto flex-shrink-0">
                  {item.createdAt &&
                    `${renderFormattedDate(item.createdAt, "yyyy-MM-dd") ?? ""} ${renderFormattedTime(item.createdAt)}`}
                </span>
              </div>
            </div>
          </Row>
        );
      })}
    </div>
  );
});
