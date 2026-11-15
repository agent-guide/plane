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
import { Bot, FileBox } from "lucide-react";
// components
import { useAgentApprovalsSelection } from "@/components/agent-teams/approvals-context";
import { ApprovalAnswerArea } from "@/components/agent-teams/approval-answer";
import { ApprovalAttachmentUpload, type AnswerAttachment } from "@/components/agent-teams/approval-attachments";
import { AgentArtifactPreviewModal } from "@/components/agent-teams/artifact-preview-modal";
import { useAgentTeamsLinks } from "@/components/agent-teams/helper";
import { MarkdownPreview } from "@/components/agent-teams/markdown-preview";
// services
import type { OrchestrationRuntimeArtifact } from "@/services/agent-teams/orchestration.service";
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
  const [attachments, setAttachments] = useState<AnswerAttachment[]>([]);
  const [errorKey, setErrorKey] = useState<"answer" | "">("");
  const [previewArtifact, setPreviewArtifact] = useState<OrchestrationRuntimeArtifact | null>(null);

  if (!selected) return null;

  const handleAnswer = async (
    decision: "approved" | "rejected",
    reason: string,
    key: string,
    attachmentIds: string[] = []
  ) => {
    setAnswering(key);
    setErrorKey("");
    try {
      await orchestrationService.answerApproval(
        workspaceSlug,
        selected.id,
        decision,
        reason || undefined,
        attachmentIds.length ? attachmentIds : undefined
      );
      setSelected(null);
      setTextAnswer("");
      setAttachments([]);
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

        {/* 审批依据：执行已产出工件（引用式上下文——问句保持简明，
            依据点名开预览弹层看全文，与工作卡执行面板同源） */}
        {(selected.contextArtifacts ?? []).length > 0 && (
          <div className="flex flex-col gap-1.5 rounded-lg border border-subtle bg-layer-1 px-3 py-2.5">
            <span className="text-caption-sm-regular text-placeholder">{t("agent_teams_stream_approval_basis")}</span>
            {(selected.contextArtifacts ?? []).map((artifact) => (
              <button
                key={artifact.id}
                type="button"
                onClick={() => setPreviewArtifact(artifact)}
                className="hover:text-accent-hover inline-flex items-center gap-1.5 text-left text-body-xs-medium text-accent-primary"
              >
                <FileBox className="size-3.5 flex-shrink-0" aria-hidden />
                <span className="truncate">{artifact.name}</span>
                <span className="font-normal flex-shrink-0 text-tertiary">v{artifact.version}</span>
              </button>
            ))}
          </div>
        )}

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
          attachmentIds={attachments.map((a) => a.id)}
          attachmentSlot={
            <ApprovalAttachmentUpload
              workspaceSlug={workspaceSlug}
              attachments={attachments}
              onAttachmentsChange={setAttachments}
              disabled={answering !== ""}
            />
          }
          onAnswer={(decision, reason, key, attachmentIds) => void handleAnswer(decision, reason, key, attachmentIds)}
        />
      </div>

      <AgentArtifactPreviewModal artifact={previewArtifact} onClose={() => setPreviewArtifact(null)} />
    </div>
  );
});
