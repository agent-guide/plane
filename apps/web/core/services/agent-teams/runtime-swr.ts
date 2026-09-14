/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * Agent Teams extension — SWR bindings for the Runtime read model (design
 * §12.6.6 thin extension). One polling principle everywhere: poll only while
 * something is actually running (executing run / waiting decision / binding
 * window), zero requests otherwise; focus revalidation still applies via the
 * global WEB_SWR_CONFIG.
 */
import { useCallback } from "react";
import useSWR from "swr";
import runtimeService, {
  type ProjectRuntimeOverview,
  type WorkItemRuntimeSummary,
  type WorkItemTimelineEntry,
} from "./runtime.service";

const ACTIVE_POLL_MS = 5000;
// A just-created work item is bound a few seconds AFTER creation (webhook →
// projection → auto-start). Poll the "not bound" null only through that
// window, measured from the work item's own created_at (not panel mount);
// past it the work item is genuinely outside runtime scope — stop, so plain
// work items in non-runtime projects never poll.
const BINDING_GRACE_MS = 30 * 1000;

const TERMINAL_CONTROL_STATUSES = new Set(["completed", "cancelled", "failed"]);

const isActive = (summary: WorkItemRuntimeSummary) => !TERMINAL_CONTROL_STATUSES.has(summary.controlStatus);

/**
 * Work Item Runtime summary + execution timeline (§12.3 panel data). The
 * timeline follows the summary's polling rhythm — it only changes when the
 * run does — and is not fetched at all for unbound work items.
 */
export function useWorkItemRuntime(issueId: string, createdAt?: string | null) {
  // True only while a just-created work item may still be picked up by the
  // runtime (webhook → projection → auto-start takes a few seconds). The
  // panel uses this to show "connecting" instead of "not bound".
  const inBindingWindow = useCallback(() => {
    if (!createdAt) return false;
    const created = new Date(createdAt).getTime();
    return Number.isFinite(created) && Date.now() - created < BINDING_GRACE_MS;
  }, [createdAt]);

  const summary = useSWR(
    issueId ? (["agent-teams", "work-item-summary", issueId] as const) : null,
    () => runtimeService.getWorkItemRuntimeSummary(issueId),
    {
      keepPreviousData: true,
      // Active runs poll; terminal stops; unbound polls only through the
      // just-created binding window.
      refreshInterval: (latest: WorkItemRuntimeSummary | null | undefined) => {
        if (latest) return isActive(latest) ? ACTIVE_POLL_MS : 0;
        return inBindingWindow() ? ACTIVE_POLL_MS : 0;
      },
      // "Not bound" comes back as a quiet null, so any thrown error is a real
      // transport/BFF hiccup — retry it, or the panel freezes on stale state
      // until the next focus revalidation.
      shouldRetryOnError: true,
    }
  );

  const summaryActive = !!summary.data && isActive(summary.data);
  // The timeline stays readable for terminal runs (it explains the final
  // state), so it loads whenever a summary exists — it just stops polling.
  const timeline = useSWR(
    summary.data ? (["agent-teams", "work-item-timeline", issueId] as const) : null,
    () => runtimeService.getWorkItemTimeline(issueId),
    { keepPreviousData: true, refreshInterval: summaryActive ? ACTIVE_POLL_MS : 0, shouldRetryOnError: false }
  );

  return { summary, timeline, inBindingWindow };
}

/** Poll while the project has anything active (runs / decisions / agents). */
export function useProjectRuntimeOverview(projectId: string) {
  return useSWR(
    projectId ? (["agent-teams", "project-overview", projectId] as const) : null,
    () => runtimeService.getProjectRuntimeOverview(projectId),
    {
      keepPreviousData: true,
      refreshInterval: (latest: ProjectRuntimeOverview | null | undefined) =>
        latest && (latest.counts.activeTasks > 0 || latest.counts.waitingHuman > 0 || latest.counts.runningAgents > 0)
          ? ACTIVE_POLL_MS
          : 0,
      shouldRetryOnError: false,
    }
  );
}
