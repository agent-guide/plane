/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Agent Teams extension — 「我的工作」待我确认区（#2）：跨项目的团队审批
 * 待办作为主动工作清单置顶（收件箱在铃铛里偏被动易漏；业界 my work 均以
 * 「需要我决策的事项」开屏）。数据与收件箱同源；作答复用共享作答区。
 */
import { useState } from "react";
import Link from "next/link";
import { useTranslation } from "@plane/i18n";
import { Card } from "@plane/ui";
import { calculateTimeAgo } from "@plane/utils";
import { Bot } from "lucide-react";
import { ApprovalAnswerArea } from "@/components/agent-teams/approval-answer";
import { usePendingApprovals } from "@/services/agent-teams/runtime-swr";
import { orchestrationService } from "@/services/agent-teams/orchestration.service";

export function ProfilePendingApprovals({ workspaceSlug }: { workspaceSlug: string }) {
  const { t } = useTranslation();
  const { items: approvals, mutate } = usePendingApprovals(workspaceSlug);
  const [answering, setAnswering] = useState("");
  const [textAnswer, setTextAnswer] = useState("");
  const [errorKey, setErrorKey] = useState("");

  if (!approvals || approvals.length === 0) return null;

  const handleAnswer = async (decision: "approved" | "rejected", reason: string, id: string) => {
    setAnswering(id);
    setErrorKey("");
    try {
      await orchestrationService.answerApproval(workspaceSlug, id, decision, reason || undefined);
      setTextAnswer("");
      await mutate();
    } catch {
      setErrorKey(id);
    } finally {
      setAnswering("");
    }
  };

  return (
    <div className="space-y-2">
      <h3 className="text-16 font-medium">{t("agent_teams_my_work_pending_title")}</h3>
      <div className="space-y-3">
        {approvals.map((approval) => (
          <Card key={approval.id} className="p-4">
            <div className="flex flex-col gap-3">
              <div className="flex items-start gap-2">
                <div className="flex size-8 flex-shrink-0 items-center justify-center rounded-lg border border-subtle bg-layer-2">
                  <Bot className="size-4 text-secondary" aria-hidden />
                </div>
                <div className="min-w-0 flex-grow">
                  <Link
                    href={`/${workspaceSlug}/projects/${approval.projectId}/issues/${approval.issueId}`}
                    className="truncate text-body-sm-medium text-primary hover:text-accent-primary hover:underline"
                  >
                    {approval.taskTitle || t("agent_teams_panel_approve_now")}
                  </Link>
                  <div className="flex items-center gap-1 text-caption-sm-regular text-tertiary">
                    <span className="truncate">{approval.teamName}</span>
                    <span aria-hidden>·</span>
                    <span className="shrink-0">{calculateTimeAgo(approval.createdAt)}</span>
                  </div>
                </div>
              </div>
              <p className="line-clamp-3 whitespace-pre-wrap text-body-sm-regular text-secondary">
                {approval.question || t("agent_teams_panel_approve_now")}
              </p>
              {errorKey === approval.id && (
                <div className="text-body-sm-regular text-danger-primary">{t("agent_teams_inbox_answer_failed")}</div>
              )}
              <ApprovalAnswerArea
                approval={{ freeText: approval.freeText, options: approval.options ?? [] }}
                answering={answering === approval.id ? answering : ""}
                textAnswer={textAnswer}
                onTextChange={setTextAnswer}
                onAnswer={(decision, reason) => void handleAnswer(decision, reason, approval.id)}
              />
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
