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
import { createPortal } from "react-dom";
import { observer } from "mobx-react";
// i18n
import { useTranslation } from "@plane/i18n";
// plane imports
import { Button } from "@plane/propel/button";
import { EModalWidth, ModalCore } from "@plane/ui";
// icons
import { Bot, ChevronDown, Clock, ExternalLink, FileBox, GitBranch, User, Users } from "lucide-react";
// components
import { SidebarPropertyListItem } from "@/components/common/layout/sidebar/property-list-item";
import { useAgentTeamsLinks } from "@/components/agent-teams/helper";
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
import Link from "next/link";
// services
import runtimeService, { type RuntimeArtifact, type WorkItemTimelineEntry } from "@/services/agent-teams/runtime.service";
import { useWorkItemRuntime } from "@/services/agent-teams/runtime-swr";
import { AgentArtifactPreviewModal } from "@/components/agent-teams/artifact-preview-modal";
import { setExpertsWorkspaceSlug } from "@/services/agent-teams/experts-auth";

type WorkItemRuntimePanelProps = {
  issueId: string;
  workspaceSlug: string;
  projectId: string;
  /** Native created_at — distinguishes "just created, binding in flight" from a genuinely unbound work item. */
  issueCreatedAt?: string | null;
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatEntryTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  // HH:MM — timeline-local times; the full date lives in the title tooltip.
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export const WorkItemRuntimePanel = observer(function WorkItemRuntimePanel({
  issueId,
  workspaceSlug,
  projectId,
  issueCreatedAt,
}: WorkItemRuntimePanelProps) {
  const { t } = useTranslation();
  const { agentTeamDetailPath } = useAgentTeamsLinks();
  // SWR-backed (runtime-swr): polls only while the run is moving — status,
  // member, step and the timeline keep flowing without a manual refresh.
  const { summary: summarySwr, timeline: timelineSwr, inBindingWindow } = useWorkItemRuntime(
    issueId,
    issueCreatedAt
  );
  const summary = summarySwr.data ?? null;
  const timeline: WorkItemTimelineEntry[] | null = timelineSwr.data ?? null;
  const loading = summarySwr.isLoading && !summarySwr.data;
  const [answering, setAnswering] = useState("");
  const [timelineOpen, setTimelineOpen] = useState(true);
  const [cancelling, setCancelling] = useState(false);
  // In-page artifact preview (§12.6) — replaces raw new-tab opens.
  const [previewArtifact, setPreviewArtifact] = useState<RuntimeArtifact | null>(null);

  const refresh = useCallback(async () => {
    await Promise.all([summarySwr.mutate(), timelineSwr.mutate()]);
  }, [summarySwr, timelineSwr]);

  // §12.6.7 BFF 身份交换按 workspace 取作用域（身份映射 connection+scope）。
  useEffect(() => {
    setExpertsWorkspaceSlug(workspaceSlug);
  }, [workspaceSlug]);

  // Runtime progress also lands in NATIVE Plane state (§6 writeback: state
  // field / assignee) and the activity feed (§12.4 agent summary comments) —
  // neither refreshes on its own. When the runtime view advances, pull both:
  // issue details + activities, same trigger pattern the attachment widgets
  // use.
  const { fetchIssue, fetchActivities } = useIssueDetail();
  const runtimeSignature = [
    summary?.controlStatus ?? "",
    summary?.currentMemberName ?? "",
    summary?.workflowStep ?? "",
    timeline?.length ?? 0,
  ].join("|");
  useEffect(() => {
    if (!summary) return;
    void fetchIssue(workspaceSlug, projectId, issueId);
    void fetchActivities(workspaceSlug, projectId, issueId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- signature covers every input
  }, [runtimeSignature]);

  const handleAnswer = useCallback(
    async (value: string) => {
      const approval = summary?.pendingApproval;
      if (!approval) return;
      setAnswering(value);
      try {
        await runtimeService.answerHumanInboxItem(approval, { value });
        await refresh();
      } catch {
        // Errors surface via the inbox page; the panel just keeps its state.
      } finally {
        setAnswering("");
      }
    },
    [summary, refresh]
  );

  const handleCancel = useCallback(async () => {
    if (!summary?.workflowRunId) return;
    setCancelling(true);
    try {
      await runtimeService.cancelWorkItemRun(summary.workflowRunId);
      await refresh();
    } catch {
      // Cancel failures surface via the admin console; panel keeps state.
    } finally {
      setCancelling(false);
    }
  }, [summary, refresh]);

  // §8 retry contract: a failed/cancelled run restarts as a NEW run — fresh
  // controlled start on the same task, lineage-linked to the terminal binding.
  // Confirmation uses the platform modal (not window.confirm) — same command
  // language as the rest of the panel.
  const [retryConfirmOpen, setRetryConfirmOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const handleRetry = useCallback(async () => {
    if (!summary?.taskId || !summary?.taskBindingId) {
      setRetryError(t("agent_teams_panel_retry_unavailable"));
      return;
    }
    setRetryError(null);
    setRetrying(true);
    try {
      await runtimeService.retryWorkItemTask(summary.taskId, summary.taskBindingId);
      setRetryConfirmOpen(false);
      // A single revalidate can be dropped (transport hiccup), and the
      // terminal state has NO polling to recover it — the panel would freeze
      // on the old "failed" view. Re-pull until the summary reflects the new
      // run (bounded: the restart is already committed server-side).
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await refresh();
        const status = summarySwr.data?.controlStatus;
        if (status && status !== "failed" && status !== "cancelled" && status !== "completed") break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } catch (error) {
      // Retry failures were previously swallowed silently — show them in the
      // modal so the user knows the restart did NOT happen (and why).
      const detail = (error as { response?: { data?: { message?: string }; status?: number } })?.response?.data;
      setRetryError(detail?.message ?? String((error as Error)?.message ?? error));
    } finally {
      setRetrying(false);
    }
  }, [summary, refresh, summarySwr, t]);

  // Deep-link target base for the admin console (A3 pages). Optional — the
  // link is simply not offered until the deployment URL is configured.
  const consoleBaseUrl = import.meta.env.VITE_RUNTIME_CONSOLE_BASE_URL as string | undefined;
  // failed is terminal too — it must show retry (not cancel) and the
  // "elapsed" label flips to total minutes.
  const isTerminal =
    summary?.controlStatus === "completed" ||
    summary?.controlStatus === "cancelled" ||
    summary?.controlStatus === "failed";

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
          inBindingWindow() ? (
            // Just created: webhook → projection → auto-start is in flight
            // (a few seconds). "Connecting", not the unbound dead-end.
            <div className="px-0.5 py-1.5 text-body-xs-regular text-placeholder">
              {t("agent_teams_panel_connecting")}
            </div>
          ) : (
            // Quiet state for work items outside any Project-Team policy.
            <div className="px-0.5 py-1.5 text-body-xs-regular text-placeholder">{t("agent_teams_panel_not_bound")}</div>
          )
        ) : (
          <>
            {/* Row rhythm mirrors the native block: space-y-2.5, h-7.5 rows,
                fixed w-30 label column — pixel-aligned with the properties
                above. */}
            <div className="space-y-2.5 truncate">
              <SidebarPropertyListItem icon={Users} label={t("agent_teams_panel_team")} childrenClassName="px-2">
                <span className="w-full truncate text-body-xs-regular leading-7.5">{summary.teamName}</span>
              </SidebarPropertyListItem>
              {summary.artifacts && summary.artifacts.length > 0 && (
                <SidebarPropertyListItem
                  icon={FileBox}
                  label={t("agent_teams_panel_artifacts")}
                  childrenClassName="px-2"
                >
                  <div className="flex w-full flex-col">
                    {summary.artifacts.map((artifact) => (
                      <button
                        key={artifact.id}
                        type="button"
                        title={t("agent_teams_panel_artifact_open")}
                        onClick={() => setPreviewArtifact(artifact)}
                        className="group flex w-full items-center gap-1.5 rounded px-1 text-left hover:bg-layer-3"
                      >
                        <FileBox className="size-3 shrink-0 text-tertiary" aria-hidden />
                        <span className="w-full truncate text-body-xs-regular leading-7.5">
                          {artifact.name} · v{artifact.version}
                        </span>
                        {artifact.sizeBytes ? (
                          <span className="shrink-0 text-caption-sm-regular text-tertiary">
                            {formatSize(artifact.sizeBytes)}
                          </span>
                        ) : null}
                        <ExternalLink
                          className="size-3 shrink-0 text-tertiary opacity-0 group-hover:text-secondary group-hover:opacity-100"
                          aria-hidden
                        />
                      </button>
                    ))}
                  </div>
                </SidebarPropertyListItem>
              )}
            </div>

            {/* Execution progress (design §12.3) — CI-style merged block: the
                headline is "now" (status + member + step), the timeline below
                is the explanation of how it got there. Replaces the former
                scattered member/step/status/duration rows + separate timeline
                section, which made users correlate fields themselves. */}
            <div className="relative mt-3 rounded-lg border border-subtle bg-layer-2 px-3.5 py-3">
              {/* Deep link to the admin run detail — corner ↗, same
                  interaction language as the artifact rows. */}
              {consoleBaseUrl && summary.workflowRunId && (
                <a
                  href={`${consoleBaseUrl}/runtime/runs/${summary.workflowRunId}`}
                  target="_blank"
                  rel="noreferrer"
                  title={t("agent_teams_panel_view_full_run")}
                  className="hover:text-secondary-hover absolute top-3 right-3 text-tertiary"
                >
                  <ExternalLink className="size-3" aria-hidden />
                </a>
              )}
              {/* Layer 1 — headline. When a decision waits on THIS user the
                  headline becomes the call to action: badge, what to decide,
                  then the commands on their own line with breathing room (no
                  member line — nothing is executing; the actor is you). */}
              {summary.pendingApproval ? (
                <div className="flex flex-col gap-3 pr-6">
                  <div className="flex flex-col gap-1.5">
                    <span className="inline-flex w-fit items-center rounded bg-accent-subtle px-2 py-0.5 text-caption-sm-medium text-accent-primary">
                      {t("agent_teams_panel_approve_now")}
                    </span>
                    <span className="truncate text-body-xs-medium text-primary">
                      {summary.pendingApproval.title || summary.workflowStep}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={answering !== ""}
                      onClick={() => void handleAnswer("approve")}
                      className="rounded-md bg-accent-primary px-3 py-1.5 text-caption-sm-medium text-on-color hover:bg-accent-primary-hover disabled:opacity-60"
                    >
                      {t("agent_teams_panel_approve")}
                    </button>
                    <button
                      type="button"
                      disabled={answering !== ""}
                      onClick={() => void handleAnswer("reject")}
                      className="rounded-md bg-danger-primary px-3 py-1.5 text-caption-sm-medium text-on-color hover:bg-danger-primary-hover disabled:opacity-60"
                    >
                      {t("agent_teams_panel_reject")}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pr-6">
                  <span
                    className={`inline-flex items-center rounded px-2 py-0.5 text-caption-sm-medium ${
                      summary.controlStatus === "waiting_human"
                        ? "bg-accent-subtle text-accent-primary"
                        : summary.controlStatus === "failed"
                          ? "bg-danger-subtle text-danger-primary"
                          : summary.controlStatus === "completed"
                            ? "bg-success-subtle text-success-primary"
                            : "bg-layer-3 text-secondary"
                    }`}
                  >
                    {t(`agent_teams_status_${summary.controlStatus}`)}
                  </span>
                  {summary.currentMemberName && (
                    <span className="inline-flex items-center gap-1 text-caption-sm-regular text-secondary">
                      <User className="size-3" aria-hidden />
                      {summary.currentMemberName}
                    </span>
                  )}
                  {summary.workflowStep && (
                    <span className="inline-flex items-center gap-1 text-caption-sm-regular text-tertiary">
                      <GitBranch className="size-3" aria-hidden />
                      <span className="max-w-[140px] truncate">{summary.workflowStep}</span>
                    </span>
                  )}
                </div>
              )}
              {/* Layer 2 — meta strip: elapsed time on the left, the timeline
                  toggle on the right; one quiet row separating headline from
                  history instead of two stacked cramped lines. */}
              {(summary.durationSeconds != null || (timeline && timeline.length > 0)) && (
                <div className="mt-3 flex items-center justify-between border-t border-subtle pt-2.5">
                  {summary.durationSeconds != null ? (
                    <span className="flex items-center gap-1 text-caption-sm-regular text-tertiary">
                      <Clock className="size-3" aria-hidden />
                      {isTerminal
                        ? t("agent_teams_panel_minutes", { count: Math.round(summary.durationSeconds / 60) })
                        : t("agent_teams_panel_elapsed", { count: Math.round(summary.durationSeconds / 60) })}
                    </span>
                  ) : (
                    <span />
                  )}
                  {timeline && timeline.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setTimelineOpen((prev) => !prev)}
                      className="hover:text-secondary-hover flex items-center gap-1 text-caption-sm-medium text-tertiary"
                    >
                      <ChevronDown
                        className={`size-3.5 transition-transform ${timelineOpen ? "" : "-rotate-90"}`}
                        aria-hidden
                      />
                      {t("agent_teams_panel_timeline")}
                    </button>
                  )}
                </div>
              )}
              {/* Layer 3 — timeline: past entries dimmed, the latest accented —
                  it IS the headline's source. Generous row spacing keeps the
                  narrow sidebar readable. */}
              {timelineOpen && timeline && timeline.length > 0 && (
                <div className="mt-2 flex flex-col">
                  {timeline.map((entry, index) => {
                    // Compact dot timeline for the narrow sidebar: 6px
                    // markers centered on a 1px rail (dot left 2.5px for
                    // a rail at left-[5px]).
                    const isLatest = index === timeline.length - 1;
                    return (
                      <div key={entry.id} className={`relative py-2 pl-5 ${index === 0 ? "mt-1" : ""}`}>
                        <div className="absolute top-0 bottom-0 left-[5px] w-px bg-layer-3" aria-hidden />
                        <span
                          className={`absolute top-1/2 left-[2.5px] size-1.5 -translate-y-1/2 rounded-full ${
                            isLatest ? "bg-accent-primary" : "bg-[var(--text-color-secondary)]"
                          }`}
                          aria-hidden
                        />
                        <span
                          className={`flex items-baseline justify-between gap-2 text-caption-sm-regular ${isLatest ? "text-secondary" : "text-tertiary"}`}
                        >
                          <span className="min-w-0 truncate">{entry.summary}</span>
                          {entry.createdAt && (
                            <span
                              className="shrink-0 text-[10px] text-placeholder tabular-nums"
                              title={new Date(entry.createdAt).toLocaleString()}
                            >
                              {formatEntryTime(entry.createdAt)}
                            </span>
                          )}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Cancel is the only footer command left — a quiet destructive
                ghost action for non-terminal runs. View-full-run moved into
                the progress card corner (↗, same interaction language as the
                artifact rows); pause has no contract — deliberately not
                offered. */}
            {summary.workflowRunId && !isTerminal && (
              <div className="mt-3 flex items-center justify-end border-t border-subtle pt-2">
                <button
                  type="button"
                  disabled={cancelling}
                  onClick={() => void handleCancel()}
                  className="text-caption-sm-regular text-tertiary hover:text-danger-primary disabled:opacity-60"
                >
                  {t("agent_teams_panel_cancel")}
                </button>
              </div>
            )}
            {/* Retry — recovery action for terminal failures (§12.6.4 command
                placement: work-facing recovery lives here, not in the console). */}
            {(summary.controlStatus === "failed" || summary.controlStatus === "cancelled") && (
              <div className="mt-3 flex items-center justify-end border-t border-subtle pt-2">
                <button
                  type="button"
                  onClick={() => setRetryConfirmOpen(true)}
                  className="text-caption-sm-medium text-accent-primary hover:text-accent-hover"
                >
                  {t("agent_teams_panel_retry")}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Retry confirmation — platform modal (ModalCore), matching the panel's
          component language instead of a native browser dialog. Portaled with
          outside-click guards: the panel lives inside the work-item peek,
          whose document-level outside-click detector would read modal clicks
          as "outside the peek" and close it (taking the modal down before the
          click handler runs) — same pitfall as the artifact preview modal. */}
      {createPortal(
        <div
          data-prevent-outside-click
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <ModalCore isOpen={retryConfirmOpen} handleClose={() => setRetryConfirmOpen(false)} width={EModalWidth.SM}>
        <div className="flex flex-col gap-4 p-6">
          <h3 className="text-base-medium text-primary">{t("agent_teams_panel_retry")}</h3>
          <p className="text-body-sm-regular text-secondary">{t("agent_teams_panel_retry_confirm")}</p>
          {retryError && (
            <p className="rounded bg-danger-subtle px-2.5 py-1.5 text-caption-sm-medium text-danger-primary">
              {retryError}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setRetryConfirmOpen(false)} disabled={retrying}>
              {t("agent_teams_panel_cancel")}
            </Button>
            <Button variant="primary" size="sm" onClick={() => void handleRetry()} disabled={retrying}>
              {retrying ? t("agent_teams_panel_retrying") : t("agent_teams_panel_retry")}
            </Button>
          </div>
        </div>
          </ModalCore>
        </div>,
        document.body
      )}

      <AgentArtifactPreviewModal artifact={previewArtifact} onClose={() => setPreviewArtifact(null)} />
    </div>
  );
});
