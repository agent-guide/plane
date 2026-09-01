/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * Agent Teams extension — Activity stream Agent Run summary renderer (design §12.4, §12.5-4).
 * Plane comments authored by a Bot/Service User carry `actor_detail.is_bot === true`
 * (design §5.2: agents are Bots). Those comments are the Agent Run summary channel and
 * get a distinct card instead of the plain comment bubble. The five structured summary
 * kinds (started / needs decision / new artifact / completed-or-failed / handoff — design
 * §12.4) will be parsed from the Runtime comment payload once the Phase 4 contract is
 * frozen; this slot only recognizes the marker and renders the raw text + a pending hint.
 */
import { observer } from "mobx-react";
// i18n
import { useTranslation } from "@plane/i18n";
// plane imports
import type { TIssueComment } from "@plane/types";
import { calculateTimeAgo, cn } from "@plane/utils";
// icons
import { Bot } from "lucide-react";

type TAgentRunSummaryCardProps = {
  comment: TIssueComment | undefined;
  ends: "top" | "bottom" | undefined;
};

export const AgentRunSummaryCard = observer(function AgentRunSummaryCard({ comment, ends }: TAgentRunSummaryCardProps) {
  const { t } = useTranslation();
  if (!comment) return null;

  const agentName = comment.actor_detail?.first_name ?? comment.actor_detail?.display_name ?? "Agent";
  const summaryText = comment.comment_stripped;

  return (
    <div
      id={comment.id}
      className={cn("relative flex gap-3", ends === "top" ? "pb-2" : ends === "bottom" ? "pt-2" : "py-2")}
    >
      {/* timeline connector */}
      <div className="absolute top-0 bottom-0 left-[13px] w-px bg-layer-3" aria-hidden />
      {/* avatar column — Bot marker */}
      <div className="relative z-[3] flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg border border-subtle bg-layer-2 shadow-raised-100">
        <Bot width={14} height={14} className="text-secondary" aria-hidden="true" />
      </div>
      {/* summary card */}
      <div className="flex flex-grow flex-col truncate">
        <div className="mb-2 rounded-lg border border-subtle bg-layer-2 p-3 shadow-raised-100">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="inline-flex items-center gap-1 rounded bg-accent-subtle px-1.5 py-0.5 text-caption-sm-medium text-accent-primary">
              <Bot className="size-3" aria-hidden="true" />
              {t("agent_teams_summary_badge")}
            </span>
            <span className="text-caption-sm-medium">{agentName}</span>
            <span className="text-caption-sm-regular text-tertiary">{calculateTimeAgo(comment.created_at)}</span>
          </div>
          {summaryText && <div className="mt-2 text-body-sm-regular whitespace-pre-wrap">{summaryText}</div>}
          <div className="border-custom-border-200 text-custom-text-400 mt-3 rounded-sm border border-dashed px-3 py-3 text-center text-11">
            {t("agent_teams_summary_pending")}
          </div>
        </div>
      </div>
    </div>
  );
});
