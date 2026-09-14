/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * Agent Teams extension — right-pane decision detail for the notifications
 * inbox's "team approvals" tab (design §12.6.4). Same content contract as
 * the approval-inbox dialog (question / context / option-or-text answer via
 * Runtime commands, §2.6), laid out as a pane instead of a modal. Answering
 * refreshes the shared pending list and releases the selection.
 */
import { useState } from "react";
import { observer } from "mobx-react";
import useSWR from "swr";
// i18n
import { useTranslation } from "@plane/i18n";
// plane imports
import { Button } from "@plane/propel/button";
import { TextArea } from "@plane/ui";
import { calculateTimeAgo, cn } from "@plane/utils";
// icons
import { Bot } from "lucide-react";
// components
import { useAgentApprovalsSelection } from "@/components/agent-teams/approvals-context";
// services
import runtimeService, { type HumanInboxItem } from "@/services/agent-teams/runtime.service";
import { usePendingApprovals } from "@/services/agent-teams/runtime-swr";

const scopeBadge = (scope: HumanInboxItem["scope"], t: (k: string) => string) =>
  scope === "workflow" ? t("agent_teams_inbox_scope_workflow") : t("agent_teams_inbox_scope_agent");

/** Context keys are raw Runtime JSON field names — humanize like the inbox. */
const contextLabel = (key: string, t: (k: string) => string) => {
  const i18nKey = `agent_teams_inbox_ctx_${key}`;
  const translated = t(i18nKey);
  return translated !== i18nKey ? translated : key;
};

export const AgentApprovalDetailPane = observer(function AgentApprovalDetailPane({
  workspaceSlug,
}: {
  workspaceSlug: string;
}) {
  const { t } = useTranslation();
  const { selected, setSelected } = useAgentApprovalsSelection();
  const { mutate: mutateApprovals } = usePendingApprovals(workspaceSlug);
  const [answering, setAnswering] = useState("");
  const [textAnswer, setTextAnswer] = useState("");
  const [errorKey, setErrorKey] = useState<"load" | "answer" | "">("");

  // Detail (question/context/options) for the selected request.
  const { data: detail, isLoading } = useSWR(
    selected ? (["agent-teams", "inbox-detail", selected.scope, selected.requestId] as const) : null,
    () => (selected ? runtimeService.getHumanInboxDetail(selected) : null),
    { shouldRetryOnError: false }
  );

  if (!selected) return null;

  const handleAnswer = async (payload: Record<string, unknown>, key: string) => {
    setAnswering(key);
    setErrorKey("");
    try {
      await runtimeService.answerHumanInboxItem(
        { scope: selected.scope, requestId: selected.requestId } as HumanInboxItem,
        payload
      );
      setSelected(null);
      setTextAnswer("");
      await mutateApprovals();
    } catch {
      setErrorKey("answer");
    } finally {
      setAnswering("");
    }
  };

  const contextEntries = Object.entries(detail?.context ?? {});
  const options = detail?.options ?? [];

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-6">
      {/* header — the item is context, the question below is the focus */}
      <div className="flex items-center gap-2">
        <div className="flex size-8 flex-shrink-0 items-center justify-center rounded-lg border border-subtle bg-layer-2">
          <Bot className="size-4 text-secondary" aria-hidden />
        </div>
        <div className="min-w-0 flex-grow">
          <div className="flex items-center gap-2">
            <span className="rounded bg-accent-subtle px-1.5 py-0.5 text-caption-sm-medium text-accent-primary">
              {scopeBadge(selected.scope, t)}
            </span>
            <span className="truncate text-body-sm-medium text-secondary">
              {selected.title ?? detail?.title ?? t("agent_teams_panel_approve_now")}
            </span>
          </div>
          <span className="text-caption-sm-regular text-tertiary">
            {[selected.taskTitle, selected.createdAt && calculateTimeAgo(selected.createdAt)]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
      </div>

      {isLoading || (!detail && !errorKey) ? (
        <div className="flex flex-col gap-2">
          <div className="h-4 w-3/4 animate-pulse rounded bg-layer-3" />
          <div className="h-4 w-1/2 animate-pulse rounded bg-layer-3" />
        </div>
      ) : (
        <>
          <p className="text-body-sm-regular text-primary">{detail?.question}</p>

          {contextEntries.length > 0 && (
            <div className="flex flex-col gap-y-1.5 rounded-md bg-layer-2 px-3.5 py-3">
              {contextEntries.map(([key, value]) => (
                <div key={key} className="flex items-baseline justify-between gap-3">
                  <span className="shrink-0 text-caption-sm-regular text-tertiary">
                    {contextLabel(key, t)}
                  </span>
                  <span className="break-all text-right text-caption-sm-regular text-secondary">
                    {String(value)}
                  </span>
                </div>
              ))}
            </div>
          )}

          {errorKey === "answer" && (
            <div className="text-body-sm-regular text-danger-primary">{t("agent_teams_inbox_answer_failed")}</div>
          )}

          {/* answer actions — option list, text input, or approve/reject */}
          <div className="flex flex-col gap-2">
            {detail?.kind === "text" ? (
              <div className="flex flex-col gap-2">
                <TextArea
                  value={textAnswer}
                  onChange={(e) => setTextAnswer(e.target.value)}
                  placeholder={t("agent_teams_inbox_answer_placeholder")}
                  className="w-full"
                />
                <Button
                  variant="primary"
                  size="sm"
                  disabled={answering !== "" || !textAnswer.trim()}
                  onClick={() => void handleAnswer({ text: textAnswer.trim() }, "text")}
                >
                  {answering === "text" ? "…" : t("agent_teams_inbox_submit")}
                </Button>
              </div>
            ) : options.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {options.map((option) => (
                  <Button
                    key={option.value}
                    variant={option.value === "approve" ? "primary" : "secondary"}
                    size="sm"
                    disabled={answering !== ""}
                    onClick={() => void handleAnswer({ value: option.value }, option.value)}
                  >
                    {answering === option.value ? "…" : option.label}
                  </Button>
                ))}
              </div>
            ) : (
              <div className="flex gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  disabled={answering !== ""}
                  onClick={() => void handleAnswer({ value: "approve" }, "approve")}
                  className={cn(answering === "approve" && "opacity-60")}
                >
                  {t("agent_teams_panel_approve")}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={answering !== ""}
                  onClick={() => void handleAnswer({ value: "reject" }, "reject")}
                >
                  {t("agent_teams_panel_reject")}
                </Button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
});
