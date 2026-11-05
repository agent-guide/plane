/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Agent Teams extension — right-pane decision detail for the notifications
 * inbox's "team approvals" tab (design §12.6.4). 数据源切换（阶段 2′）：
 * 列表项自带详情面全部字段（问题/选项/上下文），不再二次取数；作答走
 * 编排域审批端点（decision approved/rejected + reason），自定义选项/自由
 * 文本按「终止与否」映射两端结果、所选文案入 reason。Answering refreshes
 * the shared pending list and releases the selection.
 */
import { useState } from "react";
import { observer } from "mobx-react";
import Link from "next/link";
// i18n
import { useTranslation } from "@plane/i18n";
// plane imports
import { calculateTimeAgo } from "@plane/utils";
// icons
import { Bot } from "lucide-react";
// components
import { useAgentApprovalsSelection } from "@/components/agent-teams/approvals-context";
import { ApprovalAnswerArea } from "@/components/agent-teams/approval-answer";
import { useAgentTeamsLinks } from "@/components/agent-teams/helper";
import { MarkdownPreview } from "@/components/agent-teams/markdown-preview";
// services
import { orchestrationService } from "@/services/agent-teams/orchestration.service";
import { usePendingApprovals } from "@/services/agent-teams/runtime-swr";

export const AgentApprovalDetailPane = observer(function AgentApprovalDetailPane({
  workspaceSlug,
}: {
  workspaceSlug: string;
}) {
  const { t } = useTranslation();
  const { agentTeamDetailPath } = useAgentTeamsLinks();
  const { selected, setSelected } = useAgentApprovalsSelection();
  const { mutate: mutateApprovals } = usePendingApprovals(workspaceSlug);
  const [answering, setAnswering] = useState("");
  const [textAnswer, setTextAnswer] = useState("");
  const [errorKey, setErrorKey] = useState<"answer" | "">("");

  if (!selected) return null;

  const handleAnswer = async (decision: "approved" | "rejected", reason: string, key: string) => {
    setAnswering(key);
    setErrorKey("");
    try {
      await orchestrationService.answerApproval(workspaceSlug, selected.id, decision, reason || undefined);
      setSelected(null);
      setTextAnswer("");
      await mutateApprovals();
    } catch {
      setErrorKey("answer");
    } finally {
      setAnswering("");
    }
  };

  const options = selected.options ?? [];

  return (
    // Full-width pane: header pins to the top, everything below scrolls in
    // place — long checklists never push the answer actions out of reach.
    <div className="flex h-full w-full flex-col">
      {/* header — the item is context, the question below is the focus */}
      <div className="flex shrink-0 items-center gap-2 border-b border-subtle px-6 py-4">
        <div className="flex size-8 flex-shrink-0 items-center justify-center rounded-lg border border-subtle bg-layer-2">
          <Bot className="size-4 text-secondary" aria-hidden />
        </div>
        <div className="min-w-0 flex-grow">
          <div className="flex items-center gap-2">
            <span className="rounded bg-accent-subtle px-1.5 py-0.5 text-caption-sm-medium text-accent-primary">
              {t("agent_teams_inbox_scope_workflow")}
            </span>
            <span className="truncate text-body-sm-medium text-secondary">
              {selected.taskTitle || t("agent_teams_panel_approve_now")}
            </span>
          </div>
          {/* Team + task breadcrumb — both deep-link to their pages so the
              decision can be made with full context one click away. */}
          <span className="flex items-center gap-1 text-caption-sm-regular text-tertiary">
            <Link
              href={agentTeamDetailPath(selected.teamId)}
              className="truncate hover:text-secondary"
              title={selected.teamName}
            >
              {selected.teamName}
            </Link>
            <span aria-hidden>·</span>
            <Link
              href={`/${workspaceSlug}/projects/${selected.projectId}/issues/${selected.issueId}`}
              className="truncate hover:text-secondary"
              title={selected.taskTitle}
            >
              {selected.taskTitle}
            </Link>
            <span aria-hidden>·</span>
            <span className="shrink-0">{calculateTimeAgo(selected.createdAt)}</span>
          </span>
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-6">
        {/* The question body often carries agent-authored markdown
            (checklists, tables) — shared prose renderer, same treatment
            as the artifact preview. Empty question falls back to the
            generic approve-now copy. */}
        <MarkdownPreview content={selected.question || t("agent_teams_panel_approve_now")} />

        {errorKey === "answer" && (
          <div className="text-body-sm-regular text-danger-primary">{t("agent_teams_inbox_answer_failed")}</div>
        )}

        {/* answer actions — 共享作答区（freeText/选项/批准-驳回三形态，
            与工作卡执行面板同源，2026-11-04 #1） */}
        <ApprovalAnswerArea
          approval={{ freeText: selected.freeText, options }}
          answering={answering}
          textAnswer={textAnswer}
          onTextChange={setTextAnswer}
          onAnswer={(decision, reason, key) => void handleAnswer(decision, reason, key)}
        />
      </div>
    </div>
  );
});
