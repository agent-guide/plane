/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * Agent Teams extension — Work Item detail Extension Slot (design §12.3,
 * §12.5-5, §12.6.4). Shows the Runtime summary (team / current member /
 * workflow step / status / duration / cost / artifacts) and, when a human
 * decision is waiting, inline approve/reject commands. Buttons submit
 * Runtime Commands (implementation §2.6 scope-routed answer endpoints) and
 * never mutate Plane state directly.
 */
import { useCallback, useEffect, useState } from "react";
import { observer } from "mobx-react";
// i18n
import { useTranslation } from "@plane/i18n";
// icons
import { Activity, Bot, ChevronDown, Clock, Coins, ExternalLink, FileBox, GitBranch, User, Users } from "lucide-react";
// components
import { SidebarPropertyListItem } from "@/components/common/layout/sidebar/property-list-item";
import { useAgentTeamsLinks } from "@/components/agent-teams/helper";
import Link from "next/link";
// services
import runtimeService, {
  type WorkItemRuntimeSummary,
  type WorkItemTimelineEntry,
} from "@/services/agent-teams/runtime.service";

type WorkItemRuntimePanelProps = {
  issueId: string;
};

export const WorkItemRuntimePanel = observer(function WorkItemRuntimePanel({ issueId }: WorkItemRuntimePanelProps) {
  const { t } = useTranslation();
  const { agentTeamDetailPath } = useAgentTeamsLinks();
  const [summary, setSummary] = useState<WorkItemRuntimeSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [answering, setAnswering] = useState("");
  const [timeline, setTimeline] = useState<WorkItemTimelineEntry[] | null>(null);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const loadSummary = useCallback(async () => {
    setLoading(true);
    try {
      const next = await runtimeService.getWorkItemRuntimeSummary(issueId);
      setSummary(next);
      // Timeline loads alongside; failure keeps it hidden, not blocking.
      if (next) {
        try {
          setTimeline(await runtimeService.getWorkItemTimeline(issueId));
        } catch {
          setTimeline(null);
        }
      } else {
        setTimeline(null);
      }
    } catch {
      setSummary(null);
    } finally {
      setLoading(false);
    }
  }, [issueId]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  const handleAnswer = useCallback(
    async (value: string) => {
      const approval = summary?.pendingApproval;
      if (!approval) return;
      setAnswering(value);
      try {
        await runtimeService.answerHumanInboxItem(approval, { value });
        await loadSummary();
      } catch {
        // Errors surface via the inbox page; the panel just keeps its state.
      } finally {
        setAnswering("");
      }
    },
    [summary, loadSummary]
  );

  const handleCancel = useCallback(async () => {
    if (!summary?.workflowRunId) return;
    setCancelling(true);
    try {
      await runtimeService.cancelWorkItemRun(summary.workflowRunId);
      await loadSummary();
    } catch {
      // Cancel failures surface via the admin console; panel keeps state.
    } finally {
      setCancelling(false);
    }
  }, [summary, loadSummary]);

  // Deep-link target base for the admin console (A3 pages). Optional — the
  // link is simply not offered until the deployment URL is configured.
  const consoleBaseUrl = import.meta.env.VITE_RUNTIME_CONSOLE_BASE_URL as string | undefined;
  const isTerminal = summary?.controlStatus === "completed" || summary?.controlStatus === "cancelled";

  return (
    <div className="w-full" data-issue-id={issueId}>
      {/* Module header — mirrors the native "Properties" section header
          (mt-5 text-body-xs-medium) so this reads as a sibling block, with
          the Bot icon marking the agent-runtime domain. Deep-links to the
          team page when the work item is runtime-managed. */}
      <h5 className="mt-5 flex items-center gap-1.5 text-body-xs-medium text-accent-primary">
        <Bot className="size-3.5 flex-shrink-0" />
        {summary ? (
          <Link href={agentTeamDetailPath(summary.teamId)} className="hover:text-secondary">
            {t("agent_teams_panel_title")}
          </Link>
        ) : (
          t("agent_teams_panel_title")
        )}
      </h5>

      <div className="mt-4 mb-2">
        {loading ? (
          <div className="px-0.5 py-1.5 text-body-xs-regular text-placeholder">{t("agent_teams_inbox_loading")}</div>
        ) : !summary ? (
          // Quiet state for work items outside any Project-Team policy.
          <div className="px-0.5 py-1.5 text-body-xs-regular text-placeholder">{t("agent_teams_panel_not_bound")}</div>
        ) : (
          <>
            {/* Row rhythm mirrors the native block: space-y-2.5, h-7.5 rows,
                fixed w-30 label column — pixel-aligned with the properties
                above. */}
            <div className="space-y-2.5 truncate">
              <SidebarPropertyListItem icon={Users} label={t("agent_teams_panel_team")} childrenClassName="px-2">
                <span className="w-full truncate text-body-xs-regular leading-7.5">{summary.teamName}</span>
              </SidebarPropertyListItem>
              {summary.currentMemberName && (
                <SidebarPropertyListItem icon={User} label={t("agent_teams_panel_member")} childrenClassName="px-2">
                  <span className="w-full truncate text-body-xs-regular leading-7.5">{summary.currentMemberName}</span>
                </SidebarPropertyListItem>
              )}
              {summary.workflowStep && (
                <SidebarPropertyListItem icon={GitBranch} label={t("agent_teams_panel_step")} childrenClassName="px-2">
                  <span className="w-full truncate text-body-xs-regular leading-7.5">{summary.workflowStep}</span>
                </SidebarPropertyListItem>
              )}
              <SidebarPropertyListItem icon={Activity} label={t("agent_teams_panel_status")} childrenClassName="px-2">
                <span className="inline-flex h-7.5 items-center">
                  <span
                    className={`inline-flex items-center rounded px-1.5 py-0.5 text-caption-sm-medium ${
                      summary.controlStatus === "waiting_human"
                        ? "bg-accent-subtle text-accent-primary"
                        : summary.controlStatus === "failed"
                          ? "bg-danger-subtle text-danger-primary"
                          : "bg-layer-3 text-secondary"
                    }`}
                  >
                    {t(`agent_teams_status_${summary.controlStatus}`)}
                  </span>
                </span>
              </SidebarPropertyListItem>
              {summary.durationSeconds != null && (
                <SidebarPropertyListItem icon={Clock} label={t("agent_teams_panel_duration")} childrenClassName="px-2">
                  <span className="text-body-xs-regular leading-7.5">
                    {t("agent_teams_panel_minutes", { count: Math.round(summary.durationSeconds / 60) })}
                  </span>
                </SidebarPropertyListItem>
              )}
              {summary.costUsd != null && (
                <SidebarPropertyListItem icon={Coins} label={t("agent_teams_panel_cost")} childrenClassName="px-2">
                  <span className="text-body-xs-regular leading-7.5">${summary.costUsd.toFixed(2)}</span>
                </SidebarPropertyListItem>
              )}
              {summary.artifacts && summary.artifacts.length > 0 && (
                <SidebarPropertyListItem
                  icon={FileBox}
                  label={t("agent_teams_panel_artifacts")}
                  childrenClassName="px-2"
                >
                  <div className="flex w-full flex-col">
                    {summary.artifacts.map((artifact) => (
                      <span key={artifact.id} className="w-full truncate text-body-xs-regular leading-7.5">
                        {artifact.name} · v{artifact.version}
                      </span>
                    ))}
                  </div>
                </SidebarPropertyListItem>
              )}
            </div>

            {/* Inline approval commands (design §12.6.4) */}
            {summary.pendingApproval && (
              <div className="mt-3 flex flex-col gap-2 rounded-md border border-subtle bg-layer-2 px-3 py-3">
                <span className="text-caption-sm-medium text-accent-primary">
                  {t("agent_teams_panel_approve_now")} · {summary.pendingApproval.title}
                </span>
                <div className="flex justify-end gap-2">
                  {/* Approve = primary, Reject = error-fill per platform modal idiom */}
                  <button
                    type="button"
                    disabled={answering !== ""}
                    onClick={() => void handleAnswer("approve")}
                    className="rounded-md bg-accent-primary px-2.5 py-1.5 text-caption-sm-medium text-on-color hover:bg-accent-primary-hover disabled:opacity-60"
                  >
                    {t("agent_teams_panel_approve")}
                  </button>
                  <button
                    type="button"
                    disabled={answering !== ""}
                    onClick={() => void handleAnswer("reject")}
                    className="rounded-md bg-danger-primary px-2.5 py-1.5 text-caption-sm-medium text-on-color hover:bg-danger-primary-hover disabled:opacity-60"
                  >
                    {t("agent_teams_panel_reject")}
                  </button>
                </div>
              </div>
            )}

            {/* Execution timeline (design §12.3) — collapsible, entries hang
                on a rail with markers ON the line. */}
            {timeline && timeline.length > 0 && (
              <div className="mt-4">
                <button
                  type="button"
                  onClick={() => setTimelineOpen((prev) => !prev)}
                  className="hover:text-secondary-hover flex w-full items-center gap-1 py-0.5 text-body-xs-medium text-secondary"
                >
                  <ChevronDown
                    className={`size-3.5 transition-transform ${timelineOpen ? "" : "-rotate-90"}`}
                    aria-hidden
                  />
                  {t("agent_teams_panel_timeline")}
                </button>
                {timelineOpen && (
                  <div className="flex flex-col">
                    {timeline.map((entry, index) => {
                      // Compact dot timeline for the narrow sidebar: 6px
                      // markers centered on a 1px rail (dot left 2.5px for a
                      // rail at left-[5px]); the latest entry is accented so
                      // "where we are now" reads at a glance.
                      const isLatest = index === timeline.length - 1;
                      return (
                        <div key={entry.id} className={`relative py-1.5 pl-5 ${index === 0 ? "mt-1" : ""}`}>
                          <div className="absolute top-0 bottom-0 left-[5px] w-px bg-layer-3" aria-hidden />
                          <span
                            className={`absolute top-1/2 left-[2.5px] size-1.5 -translate-y-1/2 rounded-full ${
                              isLatest ? "bg-accent-primary" : "bg-[var(--text-color-secondary)]"
                            }`}
                            aria-hidden
                          />
                          <span className={`text-caption-sm-regular ${isLatest ? "text-secondary" : "text-tertiary"}`}>
                            {entry.summary}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Run commands + View full run deep link (design §12.6.4) —
                divider-anchored footer. Pause has no contract — deliberately
                not offered. */}
            {(consoleBaseUrl || (summary.workflowRunId && !isTerminal)) && (
              <div className="mt-4 flex items-center justify-end gap-3 border-t border-subtle pt-3">
                {consoleBaseUrl && summary.workflowRunId && (
                  <a
                    href={`${consoleBaseUrl}/runtime/runs/${summary.workflowRunId}`}
                    target="_blank"
                    rel="noreferrer"
                    className="hover:text-secondary-hover flex items-center gap-1 text-caption-sm-medium text-secondary"
                  >
                    {t("agent_teams_panel_view_full_run")}
                    <ExternalLink className="size-3" aria-hidden />
                  </a>
                )}
                {summary.workflowRunId && !isTerminal && (
                  <button
                    type="button"
                    disabled={cancelling}
                    onClick={() => void handleCancel()}
                    className="rounded-md border border-danger-strong bg-layer-2 px-2.5 py-1 text-caption-sm-medium text-danger-secondary hover:bg-danger-subtle disabled:opacity-60"
                  >
                    {t("agent_teams_panel_cancel")}
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
});
