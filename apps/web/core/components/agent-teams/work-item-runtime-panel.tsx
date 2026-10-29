/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Agent Teams extension — Work Item detail Extension Slot (design §12.3,
 * §12.5-5, §12.6.4). Shows the orchestration summary (team / current member /
 * workflow step / status / duration / artifacts) and, when a human decision
 * is waiting, inline approve/reject commands. 数据源切换（阶段 2′）：执行
 * 摘要与结构化时间线一次取全（时间线文案归前端 i18n）；作答走编排域审批
 * 端点；取消走执行取消端点；重试=重新受控启动（终态后同工作项新执行）。
 */
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { observer } from "mobx-react";
import useSWR from "swr";
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
import {
  orchestrationService,
  type OrchestrationRuntimeArtifact,
  type OrchestrationTimelineEvent,
  type OrchestrationWorkItemRuntime,
} from "@/services/agent-teams/orchestration.service";
import { AgentArtifactPreviewModal } from "@/components/agent-teams/artifact-preview-modal";

type WorkItemRuntimePanelProps = {
  issueId: string;
  workspaceSlug: string;
  projectId: string;
  /** 保留入参兼容调用方；新域无投影延迟窗口，不再使用。 */
  issueCreatedAt?: string | null;
};

const TERMINAL = new Set(["completed", "cancelled", "failed"]);

function formatEntryTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  // HH:MM — timeline-local times; the full date lives in the title tooltip.
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** 结构化时间线 → 文案（全部走 i18n；修复旧链服务端中文硬编码）。 */
function useTimelineLabel() {
  const { t } = useTranslation();
  return useCallback(
    (event: OrchestrationTimelineEvent): string => {
      if (event.kind === "approval") return t("agent_teams_timeline_approval");
      const statusKey = `agent_teams_status_${event.status}`;
      const statusText = t(statusKey);
      const status = statusText !== statusKey ? statusText : event.status;
      if (event.kind === "node") return `${event.nodeKey ?? ""} · ${status}`;
      return status;
    },
    [t]
  );
}

export const WorkItemRuntimePanel = observer(function WorkItemRuntimePanel({
  issueId,
  workspaceSlug,
  projectId,
}: WorkItemRuntimePanelProps) {
  const { t } = useTranslation();
  const { agentTeamDetailPath } = useAgentTeamsLinks();
  const timelineLabel = useTimelineLabel();
  // 轮询只在进行中有意义；终态/未绑定停轮询（与旧 runtime-swr 同一原则）
  const {
    data: summary,
    mutate: mutateSummary,
    isLoading,
  } = useSWR(
    workspaceSlug && projectId && issueId
      ? (["orchestration", "work-item-runtime", projectId, issueId] as const)
      : null,
    () => orchestrationService.getWorkItemRuntime(workspaceSlug, projectId, issueId),
    {
      refreshInterval: (latest: OrchestrationWorkItemRuntime | null | undefined) =>
        latest && !TERMINAL.has(latest.businessStatus) ? 5000 : 0,
      shouldRetryOnError: false,
    }
  );
  const timeline: OrchestrationTimelineEvent[] = summary?.timeline ?? [];
  const loading = isLoading && !summary;
  const [answering, setAnswering] = useState("");
  const [timelineOpen, setTimelineOpen] = useState(true);
  const [cancelling, setCancelling] = useState(false);
  // In-page artifact preview (§12.6) — replaces raw new-tab opens.
  const [previewArtifact, setPreviewArtifact] = useState<OrchestrationRuntimeArtifact | null>(null);

  const refresh = useCallback(async () => {
    await mutateSummary();
  }, [mutateSummary]);

  // Runtime progress also lands in NATIVE Plane state and the activity feed —
  // neither refreshes on its own. When the runtime view advances, pull both.
  const { fetchIssue, fetchActivities } = useIssueDetail();
  const runtimeSignature = [
    summary?.businessStatus ?? "",
    summary?.currentMemberName ?? "",
    summary?.workflowStep ?? "",
    timeline.length,
  ].join("|");
  // signature covers every input（避免 t 每渲染新引用进依赖导致的死循环教训）
  useEffect(() => {
    if (!summary) return;
    void fetchIssue(workspaceSlug, projectId, issueId);
    void fetchActivities(workspaceSlug, projectId, issueId);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- 报告锚点在依赖数组行
  }, [runtimeSignature]);

  const handleAnswer = useCallback(
    async (decision: "approved" | "rejected") => {
      const approval = summary?.pendingApproval;
      if (!approval) return;
      setAnswering(decision);
      try {
        await orchestrationService.answerApproval(workspaceSlug, approval.id, decision);
        await refresh();
      } catch {
        // Errors surface via the notifications inbox; the panel keeps its state.
      } finally {
        setAnswering("");
      }
    },
    [summary, refresh, workspaceSlug]
  );

  const handleCancel = useCallback(async () => {
    setCancelling(true);
    try {
      await orchestrationService.cancelWorkItemExecution(workspaceSlug, projectId, issueId);
      await refresh();
    } catch {
      // Cancel failures keep the panel state; status re-poll reconciles.
    } finally {
      setCancelling(false);
    }
  }, [refresh, workspaceSlug, projectId, issueId]);

  // 重试=终态后重新受控启动（同工作项新执行，绑定校验链照走）
  const [retryConfirmOpen, setRetryConfirmOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const handleRetry = useCallback(async () => {
    setRetryError(null);
    setRetrying(true);
    try {
      await orchestrationService.startExecution(workspaceSlug, projectId, issueId);
      setRetryConfirmOpen(false);
      // 串行有界重拉：终态无轮询可恢复，必须逐次确认（并行无意义）
      // oxlint-disable-next-line eslint(no-await-in-loop)
      for (let attempt = 0; attempt < 10; attempt += 1) {
        // oxlint-disable-next-line eslint(no-await-in-loop)
        await refresh();
        // oxlint-disable-next-line eslint(no-await-in-loop)
        const status = (await mutateSummary())?.businessStatus ?? "";
        if (status && !TERMINAL.has(status)) break;
        // oxlint-disable-next-line eslint(no-await-in-loop)
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } catch (error) {
      setRetryError((error as Error).message ?? String(error));
    } finally {
      setRetrying(false);
    }
  }, [refresh, mutateSummary, workspaceSlug, projectId, issueId]);

  const isTerminal = summary ? TERMINAL.has(summary.businessStatus) : false;

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
          // 未绑定（无执行记录）：新域绑定即项目级，无旧链的投影延迟窗口
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
                is the explanation of how it got there. */}
            <div className="relative mt-3 rounded-lg border border-subtle bg-layer-2 px-3.5 py-3">
              {/* Layer 1 — headline. When a decision waits on THIS user the
                  headline becomes the call to action: badge, what to decide,
                  then the commands on their own line with breathing room. */}
              {summary.pendingApproval ? (
                <div className="flex flex-col gap-3 pr-6">
                  <div className="flex flex-col gap-1.5">
                    <span className="inline-flex w-fit items-center rounded bg-accent-subtle px-2 py-0.5 text-caption-sm-medium text-accent-primary">
                      {t("agent_teams_panel_approve_now")}
                    </span>
                    <span className="truncate text-body-xs-medium text-primary">
                      {summary.pendingApproval.question || summary.pendingApproval.taskTitle || summary.workflowStep}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={answering !== ""}
                      onClick={() => void handleAnswer("approved")}
                      className="rounded-md bg-accent-primary px-3 py-1.5 text-caption-sm-medium text-on-color hover:bg-accent-primary-hover disabled:opacity-60"
                    >
                      {t("agent_teams_panel_approve")}
                    </button>
                    <button
                      type="button"
                      disabled={answering !== ""}
                      onClick={() => void handleAnswer("rejected")}
                      className="rounded-md bg-danger-primary px-3 py-1.5 text-caption-sm-medium text-on-color hover:bg-danger-primary-hover disabled:opacity-60"
                    >
                      {t("agent_teams_panel_reject")}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pr-6">
                  <span className="inline-flex items-center rounded bg-layer-3 px-2 py-0.5 text-caption-sm-medium text-secondary">
                    {t(`agent_teams_status_${summary.businessStatus}`)}
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
                  toggle on the right. */}
              {(summary.durationSeconds != null || timeline.length > 0) && (
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
                  {timeline.length > 0 && (
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
              {/* Layer 3 — timeline: past entries dimmed, the latest accented. */}
              {timelineOpen && timeline.length > 0 && (
                <div className="mt-2 flex flex-col">
                  {timeline.map((entry, index) => {
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
                          <span className="min-w-0 truncate">{timelineLabel(entry)}</span>
                          <span
                            className="shrink-0 text-[10px] text-placeholder tabular-nums"
                            title={new Date(entry.createdAt).toLocaleString()}
                          >
                            {formatEntryTime(entry.createdAt)}
                          </span>
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Cancel — quiet destructive ghost action for non-terminal runs. */}
            {!isTerminal && (
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
            {/* Retry — recovery action for terminal failures (§12.6.4). */}
            {summary.retryable && isTerminal && (
              <div className="mt-3 flex items-center justify-end border-t border-subtle pt-2">
                <button
                  type="button"
                  onClick={() => setRetryConfirmOpen(true)}
                  className="hover:text-accent-hover text-caption-sm-medium text-accent-primary"
                >
                  {t("agent_teams_panel_retry")}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Retry confirmation — platform modal (ModalCore), portaled with
          outside-click guards (the panel lives inside the work-item peek). */}
      {createPortal(
        // oxlint-disable-next-line jsx-a11y/click-events-have-key-events jsx-a11y/no-static-element-interactions
        <div data-prevent-outside-click onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
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

      <AgentArtifactPreviewModal
        artifact={previewArtifact ? { ...previewArtifact, contentUrl: previewArtifact.contentUrl } : null}
        onClose={() => setPreviewArtifact(null)}
      />
    </div>
  );
});
